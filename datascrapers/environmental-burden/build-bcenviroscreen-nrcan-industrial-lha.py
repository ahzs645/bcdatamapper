#!/usr/bin/env python3

"""Build the BC EnviroScreen industrial-sites candidate from NRCan sources.

The paper defines the industrial-sites input as the combined count of forestry
mills, producing mines, smelters/refineries, and oil/gas fields.  This builder
downloads those current official NRCan source families, assigns their point
locations to BC Local Health Areas, and emits one compact 89-LHA candidate
table.  The current files are a source-family proxy, not a claim that they are
the exact September 2020 binaries used by the paper.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import requests
from shapely.geometry import Point, shape
from shapely.strtree import STRtree


SCRIPT_DIR = Path(__file__).resolve().parent
PGMAPS_ROOT = Path(os.environ.get("PGMAPS_ROOT", SCRIPT_DIR.parents[3])).resolve()
OUTPUT_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-nrcan-industrial-lha"
CACHE_DIR = (
    SCRIPT_DIR
    / "output"
    / "bc-enviro-screen"
    / "raw-rebuild-seed"
    / "compact"
    / "nrcan-industrial"
)
LHA_PATH = PGMAPS_ROOT / "public" / "data" / "boundaries" / "BCMoH" / "local_health_areas.json"
SHINY_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "official-shiny-table" / "lha-indicators.csv"

MILLS_URL = (
    "https://ftp.maps.canada.ca/pub/nrcan_rncan/"
    "Forestry-industry_Industrie-forestiere/forest_industry_hotspots/mills_en.kml"
)
MAP_SERVER = (
    "https://maps-cartes.services.geo.ca/server_serveur/rest/services/"
    "NRCan/900A_and_top_100_en/MapServer"
)
LAYERS = {
    "metal_mines": 3,
    "nonmetal_mines": 4,
    "coal_mines": 5,
    "smelters_refineries": 8,
    "oil_gas_fields": 13,
}
TOTAL_FIELD = "nrcan_current_mills_mines_smelters_oil_gas_count"


def canonical_bytes(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode(
        "utf-8"
    )


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def download(url: str, path: Path, refresh: bool) -> bytes:
    if path.exists() and not refresh:
        return path.read_bytes()
    response = requests.get(url, timeout=120)
    response.raise_for_status()
    value = response.content
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value)
    return value


def query_layer(layer_id: int, path: Path, refresh: bool) -> dict:
    url = f"{MAP_SERVER}/{layer_id}/query"
    params = {
        "where": "province_en='British Columbia'",
        "outFields": "*",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "geojson",
    }
    if path.exists() and not refresh:
        return json.loads(path.read_text())
    response = requests.get(url, params=params, timeout=120)
    response.raise_for_status()
    document = response.json()
    if document.get("type") != "FeatureCollection":
        raise SystemExit(f"NRCan layer {layer_id} did not return GeoJSON")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical_bytes(document))
    return document


def lha_records() -> list[dict]:
    document = json.loads(LHA_PATH.read_text())
    rows = []
    for feature in document.get("features", []):
        properties = feature.get("properties") or {}
        rows.append(
            {
                "lha_code": str(properties.get("LOCAL_HLTH_AREA_CODE") or "").zfill(3),
                "lha_name": str(properties.get("LOCAL_HLTH_AREA_NAME") or ""),
                "geometry": shape(feature["geometry"]),
            }
        )
    if len(rows) != 89:
        raise SystemExit(f"Expected 89 Local Health Areas, found {len(rows)}")
    return rows


def mill_points(kml_bytes: bytes) -> list[Point]:
    root = ET.fromstring(kml_bytes)
    points = []
    for placemark in root.iter():
        if not placemark.tag.endswith("Placemark"):
            continue
        coordinates = next(
            (
                element.text
                for element in placemark.iter()
                if element.tag.endswith("coordinates") and element.text
            ),
            None,
        )
        if not coordinates:
            continue
        values = coordinates.strip().split()[0].split(",")
        if len(values) < 2:
            continue
        try:
            points.append(Point(float(values[0]), float(values[1])))
        except ValueError:
            continue
    return points


def geojson_points(document: dict) -> list[Point]:
    points = []
    for feature in document.get("features", []):
        geometry = feature.get("geometry")
        if not geometry:
            continue
        value = shape(geometry)
        if value.geom_type == "Point":
            points.append(value)
    return points


def assign_points(points: list[Point], lhas: list[dict]) -> tuple[dict[str, int], int]:
    geometries = [row["geometry"] for row in lhas]
    tree = STRtree(geometries)
    counts = defaultdict(int)
    unmatched = 0
    for point in points:
        matches = [index for index in tree.query(point) if geometries[index].covers(point)]
        if not matches:
            unmatched += 1
            continue
        row = lhas[min(matches)]
        counts[row["lha_name"]] += 1
    return counts, unmatched


def numeric(value):
    if value in {None, ""}:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def pearson(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 2:
        return None
    x_mean = sum(xs) / len(xs)
    y_mean = sum(ys) / len(ys)
    x_var = sum((value - x_mean) ** 2 for value in xs)
    y_var = sum((value - y_mean) ** 2 for value in ys)
    if not x_var or not y_var:
        return None
    covariance = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys))
    return round(covariance / math.sqrt(x_var * y_var), 6)


def comparison(rows: list[dict]) -> dict | None:
    if not SHINY_PATH.exists():
        return None
    with SHINY_PATH.open(newline="") as handle:
        shiny = {row["lha_name"]: numeric(row.get("industrial_sites")) for row in csv.DictReader(handle)}
    pairs = [
        (shiny.get(row["lha_name"]), numeric(row.get(TOTAL_FIELD)), row["lha_name"])
        for row in rows
        if shiny.get(row["lha_name"]) is not None
    ]
    xs = [pair[0] for pair in pairs]
    ys = [pair[1] for pair in pairs]
    prince_george = next((pair for pair in pairs if pair[2] == "Prince George"), None)
    differences = [abs(x - y) for x, y in zip(xs, ys)]
    return {
        "rows": len(pairs),
        "meanAbsoluteDifference": round(sum(differences) / len(differences), 6),
        "maxAbsoluteDifference": round(max(differences), 6),
        "pearsonR": pearson(xs, ys),
        "princeGeorgeRebuilt": prince_george[1] if prince_george else None,
        "princeGeorgeShiny": prince_george[0] if prince_george else None,
    }


def write_csv(path: Path, rows: list[dict]) -> None:
    headers = list(rows[0])
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true", help="Refresh official NRCan source caches.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    lhas = lha_records()
    mills_bytes = download(MILLS_URL, CACHE_DIR / "mills_en.kml", args.refresh)
    sources = {"mills": mill_points(mills_bytes)}
    source_documents = {}
    for source, layer_id in LAYERS.items():
        path = CACHE_DIR / f"900a-{source}.geojson"
        document = query_layer(layer_id, path, args.refresh)
        source_documents[source] = document
        sources[source] = geojson_points(document)

    assigned = {}
    unmatched = {}
    for source, points in sources.items():
        assigned[source], unmatched[source] = assign_points(points, lhas)

    rows = []
    for lha in sorted(lhas, key=lambda row: row["lha_name"]):
        row = {"lha_code": lha["lha_code"], "lha_name": lha["lha_name"]}
        for source in sources:
            row[f"nrcan_current_{source}_count"] = assigned[source].get(lha["lha_name"], 0)
        row[TOTAL_FIELD] = sum(row[f"nrcan_current_{source}_count"] for source in sources)
        rows.append(row)

    source_manifest = {
        "mills": {
            "url": MILLS_URL,
            "sha256": sha256_bytes(mills_bytes),
            "features": len(sources["mills"]),
            "assignedToBcLha": sum(assigned["mills"].values()),
            "unmatched": unmatched["mills"],
        }
    }
    for source, layer_id in LAYERS.items():
        value = canonical_bytes(source_documents[source])
        source_manifest[source] = {
            "url": f"{MAP_SERVER}/{layer_id}",
            "sha256": sha256_bytes(value),
            "features": len(sources[source]),
            "assignedToBcLha": sum(assigned[source].values()),
            "unmatched": unmatched[source],
        }

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    write_csv(OUTPUT_DIR / "lha-nrcan-industrial-candidates.csv", rows)
    (OUTPUT_DIR / "lha-nrcan-industrial-candidates.json").write_bytes(canonical_bytes(rows))
    manifest = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": "current-source-family-proxy",
        "paperAccessDate": "2020-09-23",
        "note": (
            "Current official NRCan source-family proxy. The exact September 2020 binaries used by "
            "the paper were not recovered."
        ),
        "candidateField": TOTAL_FIELD,
        "sources": source_manifest,
        "validationAgainstShiny": comparison(rows),
    }
    (OUTPUT_DIR / "manifest.json").write_bytes(canonical_bytes(manifest))
    print(f"BCEnviroScreen NRCan industrial candidate: wrote {OUTPUT_DIR.relative_to(PGMAPS_ROOT)}")


if __name__ == "__main__":
    main()
