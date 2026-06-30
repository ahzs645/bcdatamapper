#!/usr/bin/env python3

import csv
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pyogrio
import shapely
from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform
from shapely.strtree import STRtree
from shapely.validation import make_valid


SCRIPT_DIR = Path(__file__).resolve().parent
PGMAPS_ROOT = Path(os.environ.get("PGMAPS_ROOT", SCRIPT_DIR.parents[3])).resolve()
OUTPUT_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-ifl-lha"
RAW_SEED_LARGE_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "raw-rebuild-seed" / "large"
IFL_DIR = RAW_SEED_LARGE_DIR / "intact-forest-landscapes"
LHA_PATH = PGMAPS_ROOT / "public" / "data" / "boundaries" / "BCMoH" / "local_health_areas.json"
SHINY_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "official-shiny-table" / "lha-indicators.csv"
TO_BC_ALBERS = Transformer.from_crs("EPSG:4326", "EPSG:3005", always_xy=True).transform


def clean_geometry(geometry):
    if geometry is None or geometry.is_empty:
        return geometry
    if not geometry.is_valid:
        return make_valid(geometry)
    return geometry


def load_lhas():
    collection = json.loads(LHA_PATH.read_text())
    lhas = []
    for feature in collection["features"]:
        props = feature["properties"]
        geom = clean_geometry(transform(TO_BC_ALBERS, shape(feature["geometry"])))
        lhas.append(
            {
                "lha_code": str(props.get("LOCAL_HLTH_AREA_CODE", "")).zfill(3),
                "lha_name": props.get("LOCAL_HLTH_AREA_NAME", ""),
                "hsda_code": props.get("HLTH_SERVICE_DLVR_AREA_CODE", ""),
                "hsda_name": props.get("HLTH_SERVICE_DLVR_AREA_NAME", ""),
                "ha_code": props.get("HLTH_AUTHORITY_CODE", ""),
                "ha_name": props.get("HLTH_AUTHORITY_NAME", ""),
                "geometry_albers": geom,
                "area_sq_km": geom.area / 1_000_000,
            }
        )
    return lhas


def geometry_column(table):
    return next(
        (
            field.name
            for field in table.schema
            if field.metadata and field.metadata.get(b"ARROW:extension:name") == b"geoarrow.wkb"
        ),
        "geometry" if "geometry" in table.column_names else "geom",
    )


def load_ifl_geometries(path):
    _meta, table = pyogrio.read_arrow(path)
    geoms = shapely.from_wkb(table[geometry_column(table)].to_pylist())
    output = []
    for geom in geoms:
        geom = clean_geometry(transform(TO_BC_ALBERS, geom))
        if geom is not None and not geom.is_empty:
            output.append(geom)
    return output


def ifl_sources():
    sources = []
    for path in sorted(IFL_DIR.glob("IFL_*.gpkg")):
        try:
            year = int(path.stem.split("_", 1)[1])
        except (IndexError, ValueError):
            continue
        sources.append((year, path))
    if not sources:
        raise FileNotFoundError(f"No IFL_*.gpkg files found under {IFL_DIR}")
    return sources


def build_rows():
    lhas = load_lhas()
    rows_by_lha = {
        lha["lha_code"]: {
            key: lha[key]
            for key in ["lha_code", "lha_name", "hsda_code", "hsda_name", "ha_code", "ha_name", "area_sq_km"]
        }
        for lha in lhas
    }
    for year, path in ifl_sources():
        print(f"IFL {year}: {path.name}", flush=True)
        ifl_geoms = load_ifl_geometries(path)
        tree = STRtree(ifl_geoms)
        for lha in lhas:
            lha_geom = lha["geometry_albers"]
            intact_area_sq_km = 0.0
            intersect_count = 0
            for index in tree.query(lha_geom):
                geom = ifl_geoms[int(index)]
                if not lha_geom.intersects(geom):
                    continue
                intersect_count += 1
                try:
                    intact_area_sq_km += lha_geom.intersection(geom).area / 1_000_000
                except Exception:
                    intact_area_sq_km += lha_geom.intersection(make_valid(geom)).area / 1_000_000
            intact_percent = (intact_area_sq_km / lha["area_sq_km"] * 100) if lha["area_sq_km"] else None
            disturbed_percent = 100 - intact_percent if intact_percent is not None else None
            row = rows_by_lha[lha["lha_code"]]
            row[f"ifl_{year}_intersect_count"] = intersect_count
            row[f"ifl_{year}_intact_area_sq_km"] = round(intact_area_sq_km, 6)
            row[f"ifl_{year}_intact_area_percent"] = round(intact_percent, 6) if intact_percent is not None else None
            row[f"ifl_{year}_disturbed_area_percent"] = round(disturbed_percent, 6) if disturbed_percent is not None else None
    rows = list(rows_by_lha.values())
    return sorted(rows, key=lambda row: row["lha_code"])


def read_shiny():
    with SHINY_PATH.open(newline="") as handle:
        return {row["lha_name"]: row for row in csv.DictReader(handle)}


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def compare_to_shiny(rows):
    shiny = read_shiny()
    output = []
    for row in rows:
        shiny_row = shiny.get(row["lha_name"], {})
        for field in [key for key in row if key.startswith("ifl_") and key.endswith("_area_percent")]:
            shiny_value = number(shiny_row.get("disturbed_landscape"))
            rebuilt_value = number(row.get(field))
            if shiny_value is None or rebuilt_value is None:
                continue
            output.append(
                {
                    "lha_name": row["lha_name"],
                    "shiny_field": "disturbed_landscape",
                    "rebuilt_field": field,
                    "shiny_value": shiny_value,
                    "rebuilt_value": rebuilt_value,
                    "difference": round(rebuilt_value - shiny_value, 6),
                    "absolute_difference": round(abs(rebuilt_value - shiny_value), 6),
                }
            )
    return output


def pearson(xs, ys):
    if len(xs) < 2:
        return None
    mx = sum(xs) / len(xs)
    my = sum(ys) / len(ys)
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx <= 0 or vy <= 0:
        return None
    return round(sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / math.sqrt(vx * vy), 6)


def summarize(comparison_rows):
    grouped = defaultdict(list)
    for row in comparison_rows:
        grouped[row["rebuilt_field"]].append(row)
    rows = []
    for field, field_rows in sorted(grouped.items()):
        diffs = [row["absolute_difference"] for row in field_rows]
        xs = [row["shiny_value"] for row in field_rows]
        ys = [row["rebuilt_value"] for row in field_rows]
        pg = next((row for row in field_rows if row["lha_name"] == "Prince George"), None)
        rows.append(
            {
                "shiny_field": "disturbed_landscape",
                "rebuilt_field": field,
                "rows": len(field_rows),
                "mean_absolute_difference": round(sum(diffs) / len(diffs), 6),
                "max_absolute_difference": round(max(diffs), 6),
                "pearson_r": pearson(xs, ys),
                "prince_george_shiny": pg["shiny_value"] if pg else None,
                "prince_george_rebuilt": pg["rebuilt_value"] if pg else None,
                "prince_george_difference": pg["difference"] if pg else None,
            }
        )
    return rows


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
    rows = build_rows()
    comparisons = compare_to_shiny(rows)
    summary = summarize(comparisons)
    write_csv(OUTPUT_DIR / "lha-ifl-candidates.csv", rows)
    write_csv(OUTPUT_DIR / "shiny-comparison-long.csv", comparisons)
    write_csv(OUTPUT_DIR / "shiny-comparison-summary.csv", summary)
    (OUTPUT_DIR / "lha-ifl-candidates.json").write_text(json.dumps(rows, indent=2) + "\n")
    (OUTPUT_DIR / "shiny-comparison-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "source": "Intact Forest Landscapes 2000 GeoPackage from intactforests.org",
                "sourceUrlPattern": "https://intactforests.org/shp/IFL_{year}.gpkg",
                "sourcePaths": [str(path.relative_to(PGMAPS_ROOT)) for _year, path in ifl_sources()],
                "method": "Clip IFL polygons to LHA boundaries in EPSG:3005. Candidate disturbed landscape = 100 - intact forest area percent.",
            },
            indent=2,
        )
        + "\n"
    )
    print(f"BCEnviroScreen IFL candidates: wrote {OUTPUT_DIR.relative_to(PGMAPS_ROOT)}")


if __name__ == "__main__":
    main()
