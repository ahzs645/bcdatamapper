#!/usr/bin/env python3
"""Read the downloaded geodatabase's count, schema and extent with GDAL."""

import argparse
import hashlib
import json
from pathlib import Path
import zipfile

import pyogrio

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", choices=["polygons", "fabric"], default="polygons")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "output" / f"{args.dataset}-manifest.json").read_text())
    archive = ROOT / manifest["archive"]["file"]
    with archive.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    if checksum != manifest["archive"]["sha256"]:
        raise ValueError("Archive checksum does not match the download manifest")
    with zipfile.ZipFile(archive) as source:
        databases = sorted({n.split(".gdb/")[0] + ".gdb" for n in source.namelist() if ".gdb/" in n})
    if len(databases) != 1:
        raise ValueError("Expected exactly one File Geodatabase")
    path = f"/vsizip/{archive}/{databases[0]}"
    layers = []
    for name, _ in pyogrio.list_layers(path):
        info = pyogrio.read_info(path, layer=name, force_feature_count=True, force_total_bounds=True)
        if info["features"] <= 0 or info["geometry_type"] not in ("Polygon", "MultiPolygon"):
            raise ValueError(f"Expected nonempty polygon layer: {name}")
        if not {"PID", "OWNER_TYPE", "MUNICIPALITY"}.issubset(info["fields"]):
            raise ValueError(f"Missing required parcel attributes: {name}")
        layers.append({
            "name": name, "featureCount": info["features"], "crs": info["crs"],
            "geometryType": info["geometry_type"], "bounds": list(info["total_bounds"]),
            "fields": info["fields"].tolist(), "driver": info["driver"],
        })
    result = {
        "archiveSha256": checksum, "pyogrioVersion": pyogrio.__version__,
        "validationScope": "Archive checksum, readable geodatabase, layer count/schema/extent; no geometry repair or topology audit",
        "layers": layers,
    }
    target = ROOT / "output" / f"{args.dataset}-inspection.json"
    target.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
