#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///

"""Fetch full-resolution official 2021 census geometry for the ecumene pilot."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import urllib.parse
import urllib.request
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
CENSUS_DIR = SCRIPT_DIR.parent
DEFAULT_CROSSWALK = CENSUS_DIR / "output" / "bc_db_population_chsa_crosswalk.json"
DEFAULT_OUTPUT_DIR = SCRIPT_DIR / ".cache" / "statcan"
SERVICE_ROOT = "https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Digital_boundary_files/MapServer"
DB_LAYER = 13
DA_LAYER = 12
CMA_LAYER = 6


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--crosswalk", type=Path, default=DEFAULT_CROSSWALK)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--csd-id", default="5953023", help="2021 CSDUID; defaults to Prince George city")
    parser.add_argument("--chunk-size", type=int, default=150)
    return parser.parse_args()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def deterministic_gzip(data: bytes) -> bytes:
    output = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=output, compresslevel=9, mtime=0) as stream:
        stream.write(data)
    return output.getvalue()


def chunks(values: list[str], size: int):
    for start in range(0, len(values), size):
        yield values[start : start + size]


def query_layer(layer: int, field: str, identifiers: list[str], chunk_size: int) -> list[dict]:
    features = []
    endpoint = f"{SERVICE_ROOT}/{layer}/query"
    for group in chunks(identifiers, chunk_size):
        quoted = ",".join(f"'{identifier}'" for identifier in group)
        body = urllib.parse.urlencode(
            {
                "f": "geojson",
                "where": f"{field} IN ({quoted})",
                "outFields": field,
                "returnGeometry": "true",
                "returnTrueCurves": "false",
                "outSR": "4326",
                "geometryPrecision": "8",
            }
        ).encode()
        request = urllib.request.Request(
            endpoint,
            data=body,
            headers={"User-Agent": "BCDataMapper ecumene builder"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=120) as response:  # noqa: S310 - fixed official URL
            payload = json.load(response)
        if "error" in payload:
            raise RuntimeError(f"Statistics Canada query failed: {payload['error']}")
        features.extend(payload.get("features") or [])
    returned = [str((feature.get("properties") or {}).get(field) or "") for feature in features]
    missing = sorted(set(identifiers) - set(returned))
    duplicates = sorted(identifier for identifier in set(returned) if returned.count(identifier) > 1)
    if missing or duplicates or len(returned) != len(identifiers):
        raise RuntimeError(
            f"Unexpected {field} response: requested={len(identifiers)} returned={len(returned)} "
            f"missing={missing[:5]} duplicates={duplicates[:5]}"
        )
    return features


def encoded_collection(name: str, features: list[dict]) -> tuple[bytes, bytes]:
    collection = {"type": "FeatureCollection", "name": name, "features": features}
    raw = (json.dumps(collection, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    return raw, deterministic_gzip(raw)


def main() -> None:
    args = parse_args()
    if args.chunk_size <= 0:
        raise ValueError("--chunk-size must be positive")
    crosswalk = json.loads(args.crosswalk.read_text(encoding="utf-8"))
    records = [record for record in crosswalk["records"] if str(record.get("csdId")) == args.csd_id]
    if not records:
        raise RuntimeError(f"No crosswalk records matched CSDUID {args.csd_id}")

    by_dbuid = {str(record["dbuid"]): record for record in records}
    if len(by_dbuid) != len(records):
        raise RuntimeError("Crosswalk contains duplicate DBUIDs for the selected CSD")
    db_ids = sorted(by_dbuid)
    da_ids = sorted({str(record["daId"]) for record in records})
    cma_ids = sorted({str(record["cmaId"]) for record in records})
    if len(cma_ids) != 1:
        raise RuntimeError(f"Expected one CMA/CA for the selected CSD, found {cma_ids}")

    db_features = query_layer(DB_LAYER, "DBUID", db_ids, args.chunk_size)
    for feature in db_features:
        properties = feature.get("properties") or {}
        dbuid = str(properties["DBUID"])
        record = by_dbuid[dbuid]
        feature["properties"] = {
            "id": dbuid,
            "DBUID": dbuid,
            "population": record.get("population") or 0,
            "parentDaId": str(record["daId"]),
        }
    db_features.sort(key=lambda feature: feature["properties"]["DBUID"])

    da_features = query_layer(DA_LAYER, "DAUID", da_ids, args.chunk_size)
    for feature in da_features:
        dauid = str((feature.get("properties") or {})["DAUID"])
        feature["properties"] = {"id": dauid, "DAUID": dauid}
    da_features.sort(key=lambda feature: feature["properties"]["DAUID"])

    cma_features = query_layer(CMA_LAYER, "CMAUID", cma_ids, args.chunk_size)
    for feature in cma_features:
        cmauid = str((feature.get("properties") or {})["CMAUID"])
        feature["properties"] = {"id": cmauid, "CMAUID": cmauid}

    db_raw, db_gzip = encoded_collection("Prince George city 2021 dissemination blocks", db_features)
    da_raw, da_gzip = encoded_collection("Prince George city 2021 dissemination areas", da_features)
    cma_raw, cma_gzip = encoded_collection("Prince George 2021 census metropolitan area", cma_features)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    db_name = "prince-george-city-db-2021-full.geojson.gz"
    da_name = "prince-george-city-da-2021-full.geojson.gz"
    cma_name = "prince-george-cma-2021-full.geojson.gz"
    db_path = args.output_dir / db_name
    da_path = args.output_dir / da_name
    cma_path = args.output_dir / cma_name
    db_path.write_bytes(db_gzip)
    da_path.write_bytes(da_gzip)
    cma_path.write_bytes(cma_gzip)

    manifest = {
        "dataset": "Prince George city full-resolution 2021 census inputs for ecumene pilot",
        "status": "experimental-input-cache",
        "csduid": args.csd_id,
        "source": {
            "service": SERVICE_ROOT,
            "dbLayer": DB_LAYER,
            "daLayer": DA_LAYER,
            "cmaLayer": CMA_LAYER,
            "outputCrs": "EPSG:4326",
            "geometryPrecisionDecimalPlaces": 8,
            "license": "Statistics Canada Open Licence",
        },
        "join": {
            "populationAndParentDa": str(args.crosswalk),
            "crosswalkSha256": sha256_file(args.crosswalk),
        },
        "profile": {
            "dbCount": len(db_features),
            "populatedDbCount": sum(feature["properties"]["population"] > 0 for feature in db_features),
            "daCount": len(da_features),
            "cmaCount": len(cma_features),
        },
        "files": {
            "db": {"path": db_name, "rawBytes": len(db_raw), "gzipBytes": len(db_gzip), "sha256": sha256_bytes(db_gzip)},
            "da": {"path": da_name, "rawBytes": len(da_raw), "gzipBytes": len(da_gzip), "sha256": sha256_bytes(da_gzip)},
            "cma": {"path": cma_name, "rawBytes": len(cma_raw), "gzipBytes": len(cma_gzip), "sha256": sha256_bytes(cma_gzip)},
        },
    }
    manifest_path = args.output_dir / "prince-george-city-census-inputs.manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
