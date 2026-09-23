#!/usr/bin/env python3
"""Build a browser-ready PMTiles view of the local public-land candidate screen.

Run with: uv run --with shapely --with pyproj python
  datascrapers/bc/parcelmap/build-public-land-pmtiles.py
The ignored GeoPackage remains the source of truth. This tool does not upload it.
"""

import hashlib
import json
import sqlite3
import subprocess
import tempfile
from pathlib import Path

from pyproj import Transformer
from shapely import from_wkb, to_geojson
from shapely.ops import transform


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "source/public-land/public-land-candidates.gpkg"
OUTPUT = ROOT / "source/public-land/public-land-candidates.pmtiles"
MANIFEST = ROOT / "source/public-land/public-land-candidates-pmtiles.json"
SUMMARY = ROOT / "output/public-land/summary.json"
LAYER = "candidate_parcels"


def unpack_geometry(blob):
    if blob[:2] != b"GP":
        raise ValueError("Expected a GeoPackage geometry")
    flags = blob[3]
    envelope_sizes = (0, 32, 48, 48, 64)
    envelope = (flags >> 1) & 7
    if envelope >= len(envelope_sizes):
        raise ValueError("Unsupported GeoPackage envelope")
    return from_wkb(blob[8 + envelope_sizes[envelope]:])


def main():
    expected = json.loads(SUMMARY.read_text())["retained"]
    transformer = Transformer.from_crs(3005, 4326, always_xy=True)
    count = 0
    with tempfile.TemporaryDirectory(prefix="parcelmap-tiles-") as directory:
        geojsonl = Path(directory) / "candidates.geojsonl"
        with sqlite3.connect(SOURCE) as db, geojsonl.open("w") as output:
            rows = db.execute("""SELECT geom, PMBC_PP_SYSID, PID, OWNER_TYPE,
                              REGIONAL_DISTRICT, PARCEL_CLASS, PARCEL_STATUS
                              FROM public_land_candidates ORDER BY fid""")
            for geom, system_id, pid, owner, region, parcel_class, status in rows:
                geometry = transform(transformer.transform, unpack_geometry(geom))
                properties = {"PMBC_PP_SYSID": system_id, "PID": pid,
                              "OWNER_TYPE": owner, "REGIONAL_DISTRICT": region,
                              "PARCEL_CLASS": parcel_class, "PARCEL_STATUS": status}
                output.write('{"type":"Feature","geometry":')
                output.write(to_geojson(geometry))
                output.write(',"properties":')
                output.write(json.dumps(properties, separators=(",", ":")))
                output.write('}\n')
                count += 1
        if count != expected:
            raise ValueError(f"Candidate count {count} differs from summary {expected}")
        temporary = OUTPUT.with_suffix(".part.pmtiles")
        subprocess.run([
            "tippecanoe", "--force", "--quiet", "--output", str(temporary),
            "--layer", LAYER, "--minimum-zoom", "8", "--maximum-zoom", "14",
            "--no-feature-limit", "--no-tile-size-limit",
            "--use-attribute-for-id", "PMBC_PP_SYSID",
            "--name", "ParcelMap BC initial public-land candidates",
            "--description", "Initial ownership and park/reserve screen; not land availability or suitability.",
            str(geojsonl),
        ], check=True)
        temporary.replace(OUTPUT)

    digest = hashlib.sha256()
    with OUTPUT.open("rb") as archive:
        for chunk in iter(lambda: archive.read(1024 * 1024), b""):
            digest.update(chunk)
    summary = json.loads(SUMMARY.read_text())
    manifest = {
        "schemaVersion": 1,
        "layer": LAYER,
        "featureCount": count,
        "sourceArchiveSha256": summary["parcelArchiveSha256"],
        "sourceLastModified": summary["parcelSourceLastModified"],
        "pmtilesSha256": digest.hexdigest(),
        "pmtilesBytes": OUTPUT.stat().st_size,
        "resource": OUTPUT.name,
        "scope": "Initial public ownership and reserve/park exclusion screen; not land availability or suitability",
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
