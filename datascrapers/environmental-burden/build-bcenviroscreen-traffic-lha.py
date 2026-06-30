#!/usr/bin/env python3

import csv
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import requests
from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform
from shapely.validation import make_valid


SCRIPT_DIR = Path(__file__).resolve().parent
PGMAPS_ROOT = Path(os.environ.get("PGMAPS_ROOT", SCRIPT_DIR.parents[3])).resolve()
OUTPUT_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-traffic-lha"
RAW_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "raw-rebuild-seed" / "compact" / "traffic-data-program"
LHA_PATH = PGMAPS_ROOT / "public" / "data" / "boundaries" / "BCMoH" / "local_health_areas.json"
SHINY_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "official-shiny-table" / "lha-indicators.csv"
WFS_URL = "https://maps.th.gov.bc.ca/geoV05/ows"
UTV_TYPENAME = "tig:TIG_UTV_SEGMENT_EXT"
TO_BC_ALBERS = Transformer.from_crs("EPSG:4326", "EPSG:3005", always_xy=True).transform


def clean_geometry(geometry):
    if geometry.is_empty:
        return geometry
    if not geometry.is_valid:
        geometry = make_valid(geometry)
    return geometry


def read_csv(path):
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def numeric(value):
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def pearson(xs, ys):
    if len(xs) < 2:
        return None
    mx = sum(xs) / len(xs)
    my = sum(ys) / len(ys)
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx <= 0 or vy <= 0:
        return None
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return round(cov / math.sqrt(vx * vy), 6)


def lha_info(feature):
    props = feature["properties"]
    return {
        "lha_code": str(props.get("LOCAL_HLTH_AREA_CODE", "")).zfill(3),
        "lha_name": props.get("LOCAL_HLTH_AREA_NAME", ""),
        "hsda_code": props.get("HLTH_SERVICE_DLVR_AREA_CODE", ""),
        "hsda_name": props.get("HLTH_SERVICE_DLVR_AREA_NAME", ""),
        "ha_code": props.get("HLTH_AUTHORITY_CODE", ""),
        "ha_name": props.get("HLTH_AUTHORITY_NAME", ""),
    }


def load_lhas():
    collection = json.loads(LHA_PATH.read_text())
    lhas = []
    for feature in collection["features"]:
        geom = clean_geometry(transform(TO_BC_ALBERS, shape(feature["geometry"])))
        lhas.append(
            {
                **lha_info(feature),
                "geometry_albers": geom,
                "bounds": geom.bounds,
                "area_sq_km": geom.area / 1_000_000,
            }
        )
    return lhas


def bounds_intersect(a, b):
    return a[0] <= b[2] and a[2] >= b[0] and a[1] <= b[3] and a[3] >= b[1]


def download_utv_segments():
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    output_path = RAW_DIR / "tig-utv-segment-ext.geojson"
    if output_path.exists() and output_path.stat().st_size > 1000:
        return json.loads(output_path.read_text())

    params = {
        "service": "WFS",
        "version": "2.0.0",
        "request": "GetFeature",
        "typeName": UTV_TYPENAME,
        "outputFormat": "JSON",
        "srsName": "EPSG:4326",
        "count": 10000,
    }
    response = requests.get(WFS_URL, params=params, timeout=120)
    response.raise_for_status()
    data = response.json()
    output_path.write_text(json.dumps(data, separators=(",", ":")) + "\n")
    return data


def build_lha_rows(lhas, segments):
    rows = {
        lha["lha_code"]: {
            key: lha[key]
            for key in ["lha_code", "lha_name", "hsda_code", "hsda_name", "ha_code", "ha_name", "area_sq_km"]
        }
        for lha in lhas
    }
    totals = defaultdict(lambda: {"aadt_km": 0.0, "aadt_m": 0.0, "segment_km": 0.0, "segments": 0})

    for feature in segments.get("features", []):
        props = feature.get("properties", {})
        aadt = numeric(props.get("MAP_RENDERING_AADT"))
        if aadt is None:
            continue
        geom = clean_geometry(transform(TO_BC_ALBERS, shape(feature["geometry"])))
        if geom.is_empty:
            continue
        for lha in lhas:
            if not bounds_intersect(lha["bounds"], geom.bounds):
                continue
            intersection = clean_geometry(geom.intersection(lha["geometry_albers"]))
            if intersection.is_empty:
                continue
            length_m = intersection.length
            if length_m <= 0:
                continue
            bucket = totals[lha["lha_code"]]
            bucket["aadt_m"] += aadt * length_m
            bucket["aadt_km"] += aadt * (length_m / 1000)
            bucket["segment_km"] += length_m / 1000
            bucket["segments"] += 1

    for lha in lhas:
        row = rows[lha["lha_code"]]
        total = totals[lha["lha_code"]]
        area = row["area_sq_km"]
        row["traffic_data_program_utv_aadt_km_per_sq_km"] = round(total["aadt_km"] / area, 6) if area else None
        row["traffic_data_program_utv_aadt_m_per_sq_km"] = round(total["aadt_m"] / area, 6) if area else None
        row["traffic_data_program_utv_segment_km_per_sq_km"] = round(total["segment_km"] / area, 6) if area else None
        row["traffic_data_program_utv_segment_count"] = total["segments"]
    return [rows[key] for key in sorted(rows)]


def compare_to_shiny(rows):
    shiny = {row["lha_name"]: row for row in read_csv(SHINY_PATH)}
    candidates = [
        "traffic_data_program_utv_aadt_km_per_sq_km",
        "traffic_data_program_utv_aadt_m_per_sq_km",
        "traffic_data_program_utv_segment_km_per_sq_km",
        "traffic_data_program_utv_segment_count",
    ]
    long_rows = []
    summary_rows = []
    by_lha = {row["lha_name"]: row for row in rows}
    for candidate in candidates:
        candidate_rows = []
        for lha_name, shiny_row in shiny.items():
            source_row = by_lha.get(lha_name)
            if not source_row:
                continue
            shiny_value = numeric(shiny_row.get("traffic_density"))
            rebuilt_value = numeric(source_row.get(candidate))
            if shiny_value is None or rebuilt_value is None:
                continue
            comparison = {
                "lha_name": lha_name,
                "shiny_field": "traffic_density",
                "rebuilt_field": candidate,
                "shiny_value": shiny_value,
                "rebuilt_value": rebuilt_value,
                "difference": round(rebuilt_value - shiny_value, 6),
                "absolute_difference": round(abs(rebuilt_value - shiny_value), 6),
            }
            candidate_rows.append(comparison)
            long_rows.append(comparison)
        if not candidate_rows:
            continue
        diffs = [row["absolute_difference"] for row in candidate_rows]
        xs = [row["shiny_value"] for row in candidate_rows]
        ys = [row["rebuilt_value"] for row in candidate_rows]
        pg = next((row for row in candidate_rows if row["lha_name"] == "Prince George"), None)
        summary_rows.append(
            {
                "shiny_field": "traffic_density",
                "rebuilt_field": candidate,
                "rows": len(candidate_rows),
                "mean_absolute_difference": round(sum(diffs) / len(diffs), 6),
                "max_absolute_difference": round(max(diffs), 6),
                "pearson_r": pearson(xs, ys),
                "prince_george_shiny": pg["shiny_value"] if pg else None,
                "prince_george_rebuilt": pg["rebuilt_value"] if pg else None,
                "prince_george_difference": pg["difference"] if pg else None,
            }
        )
    return long_rows, summary_rows


def write_csv(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("")
        return
    headers = []
    for row in rows:
        for key in row:
            if key not in headers:
                headers.append(key)
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    lhas = load_lhas()
    segments = download_utv_segments()
    rows = build_lha_rows(lhas, segments)
    long_rows, summary_rows = compare_to_shiny(rows)

    write_csv(OUTPUT_DIR / "lha-traffic-candidates.csv", rows)
    write_csv(OUTPUT_DIR / "shiny-comparison-long.csv", long_rows)
    write_csv(OUTPUT_DIR / "shiny-comparison-summary.csv", summary_rows)
    (OUTPUT_DIR / "lha-traffic-candidates.json").write_text(json.dumps(rows, indent=2) + "\n")
    (OUTPUT_DIR / "shiny-comparison-summary.json").write_text(json.dumps(summary_rows, indent=2) + "\n")
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "source": {
                    "name": "BC Ministry of Transportation and Transit Traffic Data Program UTV segments",
                    "url": WFS_URL,
                    "typeName": UTV_TYPENAME,
                    "cachedGeojson": str((RAW_DIR / "tig-utv-segment-ext.geojson").relative_to(SCRIPT_DIR)),
                    "features": len(segments.get("features", [])),
                },
                "method": "Clip UTV segments to LHA in EPSG:3005 and aggregate MAP_RENDERING_AADT weighted by clipped segment length.",
                "outputs": {
                    "candidatesCsv": "lha-traffic-candidates.csv",
                    "comparisonSummaryCsv": "shiny-comparison-summary.csv",
                    "comparisonLongCsv": "shiny-comparison-long.csv",
                },
            },
            indent=2,
        )
        + "\n"
    )
    print(f"BCEnviroScreen traffic LHA: wrote {OUTPUT_DIR.relative_to(PGMAPS_ROOT)}")


if __name__ == "__main__":
    main()
