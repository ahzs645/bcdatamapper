#!/usr/bin/env python3

import csv
import json
import os
import zipfile
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
OUTPUT_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-disturbed-lha"
RAW_SEED_LARGE_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "raw-rebuild-seed" / "large"
SOURCE_DIR = RAW_SEED_LARGE_DIR / "bc-human-disturbance-2025"
SOURCE_ZIP = SOURCE_DIR / "2025-data.fgdb.zip"
SOURCE_GPKG = SOURCE_DIR / "BC_Human_Disturbance_2025.gpkg"
SOURCE_LAYER = "BC_Human_Disturb_noBTM_2025_merge"
LHA_PATH = PGMAPS_ROOT / "public" / "data" / "boundaries" / "BCMoH" / "local_health_areas.json"
SHINY_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "official-shiny-table" / "lha-indicators.csv"
TO_BC_ALBERS = Transformer.from_crs("EPSG:4326", "EPSG:3005", always_xy=True).transform


def parse_args(argv):
    args = {"batch-size": "25000", "extract": "true"}
    index = 0
    while index < len(argv):
        token = argv[index]
        if token.startswith("--"):
            key = token[2:]
            if index + 1 < len(argv) and not argv[index + 1].startswith("--"):
                args[key] = argv[index + 1]
                index += 2
            else:
                args[key] = "true"
                index += 1
        else:
            index += 1
    return args


def clean_geometry(geometry):
    if geometry is None or geometry.is_empty:
        return geometry
    if not geometry.is_valid:
        return make_valid(geometry)
    return geometry


def load_lhas():
    collection = json.loads(LHA_PATH.read_text())
    rows = []
    for feature in collection["features"]:
        props = feature["properties"]
        geom = clean_geometry(transform(TO_BC_ALBERS, shape(feature["geometry"])))
        rows.append(
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
    return rows


def ensure_gpkg(extract=True):
    if SOURCE_GPKG.exists():
        return SOURCE_GPKG
    if not extract:
        return SOURCE_ZIP
    if not SOURCE_ZIP.exists():
        raise FileNotFoundError(SOURCE_ZIP)
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(SOURCE_ZIP) as archive:
        member = next(name for name in archive.namelist() if name.lower().endswith(".gpkg"))
        tmp_path = SOURCE_GPKG.with_suffix(".gpkg.tmp")
        with archive.open(member) as source, tmp_path.open("wb") as target:
            while True:
                chunk = source.read(1024 * 1024 * 16)
                if not chunk:
                    break
                target.write(chunk)
        tmp_path.replace(SOURCE_GPKG)
    return SOURCE_GPKG


def read_shiny():
    with SHINY_PATH.open(newline="") as handle:
        return {row["lha_name"]: row for row in csv.DictReader(handle)}


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


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


def assign_disturbance(source_path, batch_size):
    lhas = load_lhas()
    lha_geoms = [lha["geometry_albers"] for lha in lhas]
    lha_tree = STRtree(lha_geoms)
    rows = {
        lha["lha_code"]: {
            key: lha[key]
            for key in ["lha_code", "lha_name", "hsda_code", "hsda_name", "ha_code", "ha_name", "area_sq_km"]
        }
        for lha in lhas
    }
    for row in rows.values():
        row["human_disturbance_2025_rep_point_area_ha"] = 0.0
        row["human_disturbance_2025_rep_point_feature_count"] = 0

    info = pyogrio.read_info(source_path, layer=SOURCE_LAYER)
    feature_count = int(info["features"])
    for offset in range(0, feature_count, batch_size):
        print(f"Human Disturbance 2025: {offset:,}/{feature_count:,}", flush=True)
        _meta, table = pyogrio.read_arrow(
            source_path,
            layer=SOURCE_LAYER,
            columns=["AREA_HA", "HUMAN_DISTURB_FLAG"],
            skip_features=offset,
            max_features=batch_size,
        )
        area_values = table["AREA_HA"].to_pylist()
        flags = table["HUMAN_DISTURB_FLAG"].to_pylist()
        geometry_column = next(
            (
                field.name
                for field in table.schema
                if field.metadata and field.metadata.get(b"ARROW:extension:name") == b"geoarrow.wkb"
            ),
            "geometry" if "geometry" in table.column_names else None,
        )
        if geometry_column is None:
            raise KeyError(f"Could not identify geometry column in {table.column_names}")
        geoms = shapely.from_wkb(table[geometry_column].to_pylist())
        for geom, area_ha, flag in zip(geoms, area_values, flags):
            if geom is None or geom.is_empty:
                continue
            if str(flag).strip().upper() in {"N", "NO", "FALSE", "0"}:
                continue
            geom = clean_geometry(geom)
            if geom is None or geom.is_empty:
                continue
            point = geom.representative_point()
            for index in lha_tree.query(point):
                if not lha_geoms[int(index)].covers(point):
                    continue
                lha = lhas[int(index)]
                row = rows[lha["lha_code"]]
                row["human_disturbance_2025_rep_point_area_ha"] += float(area_ha or (geom.area / 10_000))
                row["human_disturbance_2025_rep_point_feature_count"] += 1
                break

    for row in rows.values():
        area_sq_km = row["area_sq_km"]
        area_ha = row["human_disturbance_2025_rep_point_area_ha"]
        # 1 sq km = 100 ha; percent = disturbed ha / (area sq km * 100) * 100.
        row["human_disturbance_2025_rep_point_area_percent"] = round(area_ha / area_sq_km, 6) if area_sq_km else None
        row["human_disturbance_2025_rep_point_area_ha"] = round(area_ha, 6)
    return [rows[key] for key in sorted(rows)]


def compare_to_shiny(rows):
    shiny = read_shiny()
    output = []
    for row in rows:
        shiny_row = shiny.get(row["lha_name"], {})
        shiny_value = number(shiny_row.get("disturbed_landscape"))
        rebuilt_value = number(row.get("human_disturbance_2025_rep_point_area_percent"))
        if shiny_value is None or rebuilt_value is None:
            continue
        output.append(
            {
                "lha_name": row["lha_name"],
                "shiny_field": "disturbed_landscape",
                "rebuilt_field": "human_disturbance_2025_rep_point_area_percent",
                "shiny_value": shiny_value,
                "rebuilt_value": rebuilt_value,
                "difference": round(rebuilt_value - shiny_value, 6),
                "absolute_difference": round(abs(rebuilt_value - shiny_value), 6),
            }
        )
    return output


def pearson(xs, ys):
    import math

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
    if not comparison_rows:
        return []
    diffs = [row["absolute_difference"] for row in comparison_rows]
    xs = [row["shiny_value"] for row in comparison_rows]
    ys = [row["rebuilt_value"] for row in comparison_rows]
    pg = next((row for row in comparison_rows if row["lha_name"] == "Prince George"), None)
    return [
        {
            "shiny_field": "disturbed_landscape",
            "rebuilt_field": "human_disturbance_2025_rep_point_area_percent",
            "rows": len(comparison_rows),
            "mean_absolute_difference": round(sum(diffs) / len(diffs), 6),
            "max_absolute_difference": round(max(diffs), 6),
            "pearson_r": pearson(xs, ys),
            "prince_george_shiny": pg["shiny_value"] if pg else None,
            "prince_george_rebuilt": pg["rebuilt_value"] if pg else None,
            "prince_george_difference": pg["difference"] if pg else None,
        }
    ]


def main():
    args = parse_args(os.sys.argv[1:])
    batch_size = int(args["batch-size"])
    source_path = ensure_gpkg(extract=args.get("extract") != "false")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    rows = assign_disturbance(source_path, batch_size)
    comparisons = compare_to_shiny(rows)
    summary = summarize(comparisons)
    write_csv(OUTPUT_DIR / "lha-disturbed-candidates.csv", rows)
    write_csv(OUTPUT_DIR / "shiny-comparison-long.csv", comparisons)
    write_csv(OUTPUT_DIR / "shiny-comparison-summary.csv", summary)
    (OUTPUT_DIR / "lha-disturbed-candidates.json").write_text(json.dumps(rows, indent=2) + "\n")
    (OUTPUT_DIR / "shiny-comparison-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "sourceZip": str(SOURCE_ZIP.relative_to(PGMAPS_ROOT)),
                "sourcePath": str(source_path.relative_to(PGMAPS_ROOT)),
                "sourceLayer": SOURCE_LAYER,
                "method": "Modern proxy: sum Human Disturbance 2025 AREA_HA by assigning each disturbance polygon to the LHA containing its representative point; percent = disturbed hectares / LHA square kilometres.",
                "notes": [
                    "This is a modern 2025 proxy, not the paper-era disturbed-landscape source.",
                    "Representative-point assignment is faster than polygon clipping and may differ near LHA boundaries.",
                ],
            },
            indent=2,
        )
        + "\n"
    )
    print(f"BCEnviroScreen disturbed landscape candidates: wrote {OUTPUT_DIR.relative_to(PGMAPS_ROOT)}")


if __name__ == "__main__":
    main()
