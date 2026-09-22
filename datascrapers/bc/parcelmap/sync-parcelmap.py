#!/usr/bin/env python3
"""Download and validate the official province-wide ParcelMap BC archive."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import urllib.request
import zipfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent
DATASETS = {
    "polygons": "2f4117d9-41fc-44db-87d4-dbdb77f14086",
    "fabric": "4cf233c2-f020-4f7a-9b87-1923252fbc24",
}


def request(url):
    return urllib.request.urlopen(urllib.request.Request(
        url, headers={"User-Agent": "bcdatamapper-parcelmap/1.0"}
    ), timeout=120)


def archive_resource(catalogue):
    # Prefer the warehouse's BC Albers extract over the alternate LTSA extract.
    resources = [r for r in catalogue["resources"]
                 if r.get("format", "").lower() == "fgdb"
                 and r.get("url", "").endswith(".zip")]
    preferred = [r for r in resources if "/pmbc_" in r["url"]]
    if len(preferred) != 1:
        raise ValueError("Expected one official pmbc_ File Geodatabase download")
    return preferred[0]


def download(url, destination):
    """Keep the previous archive intact until the replacement passes validation."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        temporary = None
        try:
            digest = hashlib.sha256()
            size = 0
            next_report = 64 * 1024 * 1024
            with request(url) as response, tempfile.NamedTemporaryFile(
                dir=destination.parent, suffix=".part", delete=False
            ) as output:
                temporary = Path(output.name)
                if response.status != 200:
                    raise ValueError(f"Expected complete archive, got HTTP {response.status}")
                expected = response.headers.get("Content-Length")
                modified = response.headers.get("Last-Modified")
                etag = response.headers.get("ETag")
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
                    if size >= next_report:
                        print(f"Downloaded {size / 1_000_000:.1f} MB", flush=True)
                        next_report += 64 * 1024 * 1024
            if expected is not None and size != int(expected):
                raise ValueError(f"Incomplete archive: {size} bytes, expected {expected}")
            with zipfile.ZipFile(temporary) as archive:
                members = archive.infolist()
                if not any(".gdb/" in m.filename.lower() and not m.is_dir() for m in members):
                    raise ValueError("Archive does not contain a File Geodatabase")
                bad = archive.testzip()
                if bad:
                    raise ValueError(f"ZIP CRC validation failed: {bad}")
                expanded_size = sum(m.file_size for m in members)
            os.replace(temporary, destination)
            return {
                "file": str(destination.relative_to(ROOT)),
                "bytes": size,
                "uncompressedBytes": expanded_size,
                "sha256": digest.hexdigest(),
                "lastModified": modified,
                "etag": etag,
                "zipCrcValidated": True,
            }
        except Exception:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", choices=DATASETS, default="polygons")
    args = parser.parse_args()
    dataset_id = DATASETS[args.dataset]
    catalogue_url = f"https://catalogue.data.gov.bc.ca/api/3/action/package_show?id={dataset_id}"
    with request(catalogue_url) as response:
        result = json.load(response)
    if not result.get("success"):
        raise ValueError("Catalogue request failed")
    catalogue = result["result"]
    resource = archive_resource(catalogue)
    url = resource["url"]
    print(f"Downloading {catalogue['title']} from {url}", flush=True)
    archive = download(url, ROOT / "source" / args.dataset / url.rsplit("/", 1)[-1])
    manifest = {
        "dataset": args.dataset,
        "title": catalogue["title"],
        "coverage": "British Columbia, province-wide",
        "retrievedAt": datetime.now(timezone.utc).isoformat(),
        "catalogueUrl": f"https://catalogue.data.gov.bc.ca/dataset/{dataset_id}",
        "downloadUrl": url,
        "licence": catalogue.get("license_title"),
        "licenceUrl": catalogue.get("license_url"),
        "attribution": "ParcelMap BC, Land Title and Survey Authority of British Columbia; distributed by DataBC",
        "sourceCrs": resource.get("projection_name"),
        "format": "Esri File Geodatabase (ZIP)",
        "geometryProcessing": "None; original archive preserved byte-for-byte",
        "strataRepresentation": (
            "One polygon per building strata plan; individual strata lot PIDs excluded"
            if args.dataset == "polygons" else
            "Includes stacked geometries for individual building strata parcels"
        ),
        "archive": archive,
    }
    output = ROOT / "output"
    output.mkdir(parents=True, exist_ok=True)
    target = output / f"{args.dataset}-manifest.json"
    temporary = target.with_suffix(".json.part")
    temporary.write_text(json.dumps(manifest, indent=2) + "\n")
    os.replace(temporary, target)
    print(json.dumps(manifest, indent=2), flush=True)


if __name__ == "__main__":
    main()
