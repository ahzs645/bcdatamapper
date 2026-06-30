#!/usr/bin/env python3

import csv
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pyogrio
import pyarrow.parquet as pq
import shapely
from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform
from shapely.strtree import STRtree
from shapely.validation import make_valid


SCRIPT_DIR = Path(__file__).resolve().parent
PGMAPS_ROOT = Path(os.environ.get("PGMAPS_ROOT", SCRIPT_DIR.parents[3])).resolve()
OUTPUT_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-spatial-lha"
FULL_BC_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "full-bc"
RAW_SEED_LARGE_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "raw-rebuild-seed" / "large"
DRA_GDB_PATH = RAW_SEED_LARGE_DIR / "digital-road-atlas" / "dgtl_road_atlas.gdb.zip"
DRA_PARQUET_DIR = RAW_SEED_LARGE_DIR / "digital-road-atlas" / "parquet"
LHA_PATH = PGMAPS_ROOT / "public" / "data" / "boundaries" / "BCMoH" / "local_health_areas.json"
SHINY_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "official-shiny-table" / "lha-indicators.csv"
TO_BC_ALBERS = Transformer.from_crs("EPSG:4326", "EPSG:3005", always_xy=True).transform


SOURCES = {
    "remediation": FULL_BC_DIR / "bc-environmental-remediation-sites.geojson",
    "timber": FULL_BC_DIR / "bc-major-timber-processing-facilities.geojson",
    "mines": FULL_BC_DIR / "bc-permitted-mine-areas-major-mine.geojson",
    "oilgas": FULL_BC_DIR / "bc-oil-and-gas-fields.geojson",
    "wildfire": FULL_BC_DIR / "bc-wildfire-historical-fire-perimeters.geojson",
}


LINEAR_SOURCES = {
    "bcer_geophysical_lines": RAW_SEED_LARGE_DIR
    / "linear-footprint"
    / "bcer_geophysical_lines_2020_no_handcut_aero"
    / "pages",
    "bcer_geophysical_final_plans": RAW_SEED_LARGE_DIR
    / "linear-footprint"
    / "bcer_geophysical_final_plans_1996_2004_no_handcut_aero"
    / "pages",
    "bcer_pipeline_segments": RAW_SEED_LARGE_DIR / "linear-footprint" / "bcer_pipeline_segments_2020" / "pages",
    "bcgw_forest_tenure_road_sections": RAW_SEED_LARGE_DIR
    / "linear-footprint"
    / "bcgw_forest_tenure_road_sections"
    / "pages",
    "bcgw_railway_track": RAW_SEED_LARGE_DIR / "linear-footprint" / "bcgw_railway_track" / "pages",
    "bcgw_transmission_lines": RAW_SEED_LARGE_DIR / "linear-footprint" / "bcgw_transmission_lines" / "pages",
}


DRA_GDB_LAYERS = {
    "bcgw_digital_road_atlas_mpar": "DGTL_ROAD_ATLAS_MPAR_SP",
    "bcgw_digital_road_atlas_dpar": "DGTL_ROAD_ATLAS_DPAR_SP",
}


DRA_PARQUET_FILES = {
    "bcgw_digital_road_atlas_mpar": DRA_PARQUET_DIR / "dgtl_road_atlas_mpar.parquet",
    "bcgw_digital_road_atlas_dpar": DRA_PARQUET_DIR / "dgtl_road_atlas_dpar.parquet",
}


WILDFIRE_WINDOWS = {
    "wildfire_all_years": None,
    "wildfire_2001_2010": (2001, 2010),
    "wildfire_2008_2017": (2008, 2017),
    "wildfire_2010_2019": (2010, 2019),
    "wildfire_2011_2020": (2011, 2020),
    "wildfire_2015_2024": (2015, 2024),
}


def load_geojson(path):
    return json.loads(path.read_text())


def clean_geometry(geometry):
    if geometry.is_empty:
        return geometry
    if not geometry.is_valid:
        geometry = make_valid(geometry)
    return geometry


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
    collection = load_geojson(LHA_PATH)
    lhas = []
    for feature in collection["features"]:
        geom_wgs84 = clean_geometry(shape(feature["geometry"]))
        geom_albers = clean_geometry(transform(TO_BC_ALBERS, geom_wgs84))
        lhas.append(
            {
                **lha_info(feature),
                "geometry_wgs84": geom_wgs84,
                "geometry_albers": geom_albers,
                "area_sq_km": geom_albers.area / 1_000_000,
            }
        )
    return lhas


def init_rows(lhas):
    return {
        lha["lha_code"]: {
            key: lha[key]
            for key in ["lha_code", "lha_name", "hsda_code", "hsda_name", "ha_code", "ha_name", "area_sq_km"]
        }
        for lha in lhas
    }


def assign_points_to_lha(rows, lhas, path, output_field):
    collection = load_geojson(path)
    for row in rows.values():
        row[output_field] = 0

    for feature in collection["features"]:
        geom = shape(feature["geometry"])
        point = geom if geom.geom_type == "Point" else geom.representative_point()
        for lha in lhas:
            if not bounds_intersect(lha["geometry_wgs84"].bounds, point.bounds):
                continue
            if lha["geometry_wgs84"].covers(point):
                rows[lha["lha_code"]][output_field] += 1
                break


def assign_representative_points_to_lha(rows, lhas, path, output_field, property_filter=None, unique_property=None):
    collection = load_geojson(path)
    if unique_property:
        values_by_lha = {lha_code: set() for lha_code in rows}
    else:
        for row in rows.values():
            row[output_field] = 0

    for feature in collection["features"]:
        properties = feature.get("properties", {})
        if property_filter and not property_filter(properties):
            continue
        geom = shape(feature["geometry"])
        point = geom if geom.geom_type == "Point" else geom.representative_point()
        for lha in lhas:
            if not bounds_intersect(lha["geometry_wgs84"].bounds, point.bounds):
                continue
            if lha["geometry_wgs84"].covers(point):
                if unique_property:
                    value = properties.get(unique_property)
                    if value not in (None, ""):
                        rows[lha["lha_code"]].setdefault(output_field, 0)
                        values_by_lha[lha["lha_code"]].add(value)
                else:
                    rows[lha["lha_code"]][output_field] += 1
                break

    if unique_property:
        for lha_code, values in values_by_lha.items():
            rows[lha_code][output_field] = len(values)


def add_point_counts(rows, lhas):
    assign_points_to_lha(rows, lhas, SOURCES["remediation"], "remediation_sites_count")
    assign_representative_points_to_lha(
        rows,
        lhas,
        SOURCES["remediation"],
        "remediation_sites_site_id_lte_23504_count",
        property_filter=lambda props: int(props.get("SITE_ID") or 0) <= 23504,
    )
    assign_points_to_lha(rows, lhas, SOURCES["timber"], "timber_facilities_count")
    assign_representative_points_to_lha(
        rows,
        lhas,
        SOURCES["mines"],
        "operating_major_mines_representative_count",
        property_filter=lambda props: str(props.get("OP_STATUS_DESC", "")).strip().lower() == "operating",
    )
    assign_representative_points_to_lha(rows, lhas, SOURCES["mines"], "major_mines_representative_count")
    assign_representative_points_to_lha(
        rows,
        lhas,
        SOURCES["oilgas"],
        "oil_gas_unique_field_names_count",
        unique_property="FIELD_AREA_NAME",
    )
    assign_representative_points_to_lha(
        rows,
        lhas,
        SOURCES["oilgas"],
        "oil_unique_field_names_count",
        property_filter=lambda props: str(props.get("FIELD_TYPE", "")).strip().lower() == "oil",
        unique_property="FIELD_AREA_NAME",
    )
    assign_representative_points_to_lha(
        rows,
        lhas,
        SOURCES["oilgas"],
        "gas_unique_field_names_count",
        property_filter=lambda props: str(props.get("FIELD_TYPE", "")).strip().lower() == "gas",
        unique_property="FIELD_AREA_NAME",
    )


def bounds_intersect(left, right):
    return not (left[2] < right[0] or left[0] > right[2] or left[3] < right[1] or left[1] > right[3])


def build_polygon_index(path, year_window=None, property_filter=None):
    features = load_geojson(path)["features"]
    geoms = []
    props = []
    for feature in features:
        properties = feature.get("properties", {})
        if property_filter and not property_filter(properties):
            continue
        if year_window:
            year = properties.get("FIRE_YEAR")
            if year is None or int(year) < year_window[0] or int(year) > year_window[1]:
                continue
        geom = clean_geometry(transform(TO_BC_ALBERS, shape(feature["geometry"])))
        if geom.is_empty:
            continue
        geoms.append(geom)
        props.append(properties)
    return geoms, props, STRtree(geoms) if geoms else None


def intersects_any(a, b):
    return a.intersects(b)


def add_polygon_metrics(rows, lhas, path, prefix, area_percent=True, year_window=None, property_filter=None):
    geoms, _props, tree = build_polygon_index(path, year_window=year_window, property_filter=property_filter)
    count_field = f"{prefix}_intersect_count"
    area_field = f"{prefix}_area_sq_km"
    percent_field = f"{prefix}_area_percent"
    for row in rows.values():
        row[count_field] = 0
        row[area_field] = 0
        if area_percent:
            row[percent_field] = 0

    if tree is None:
        return

    for lha in lhas:
        lha_geom = lha["geometry_albers"]
        seen_count = 0
        area = 0
        for index in tree.query(lha_geom):
            geom = geoms[int(index)]
            if not intersects_any(lha_geom, geom):
                continue
            seen_count += 1
            try:
                area += lha_geom.intersection(geom).area / 1_000_000
            except Exception:
                area += lha_geom.intersection(make_valid(geom)).area / 1_000_000
        row = rows[lha["lha_code"]]
        row[count_field] = seen_count
        row[area_field] = round(area, 6)
        if area_percent:
            row[percent_field] = round((area / lha["area_sq_km"]) * 100, 6) if lha["area_sq_km"] else None


def add_polygon_aggregates(rows, lhas):
    add_polygon_metrics(rows, lhas, SOURCES["mines"], "major_mines")
    add_polygon_metrics(
        rows,
        lhas,
        SOURCES["mines"],
        "operating_major_mines",
        property_filter=lambda props: str(props.get("OP_STATUS_DESC", "")).strip().lower() == "operating",
    )
    add_polygon_metrics(
        rows,
        lhas,
        SOURCES["mines"],
        "major_mines_issued_through_2022",
        property_filter=lambda props: str(props.get("ISSUE_DATE", ""))[:10] <= "2022-12-31",
    )
    add_polygon_metrics(
        rows,
        lhas,
        SOURCES["mines"],
        "operating_major_mines_issued_through_2022",
        property_filter=lambda props: str(props.get("ISSUE_DATE", ""))[:10] <= "2022-12-31"
        and str(props.get("OP_STATUS_DESC", "")).strip().lower() == "operating",
    )
    add_polygon_metrics(rows, lhas, SOURCES["oilgas"], "oil_gas_fields")
    for prefix, window in WILDFIRE_WINDOWS.items():
        add_polygon_metrics(rows, lhas, SOURCES["wildfire"], prefix, year_window=window)

    for row in rows.values():
        row["industrial_sites_proxy_count"] = (
            row.get("timber_facilities_count", 0)
            + row.get("major_mines_intersect_count", 0)
            + row.get("oil_gas_fields_intersect_count", 0)
        )
        row["industrial_sites_operating_proxy_count"] = (
            row.get("timber_facilities_count", 0)
            + row.get("operating_major_mines_intersect_count", 0)
            + row.get("oil_gas_fields_intersect_count", 0)
        )
        row["industrial_sites_2022_proxy_count"] = (
            row.get("timber_facilities_count", 0)
            + row.get("major_mines_issued_through_2022_intersect_count", 0)
            + row.get("oil_gas_fields_intersect_count", 0)
        )
        row["industrial_sites_operating_2022_proxy_count"] = (
            row.get("timber_facilities_count", 0)
            + row.get("operating_major_mines_issued_through_2022_intersect_count", 0)
            + row.get("oil_gas_fields_intersect_count", 0)
        )
        row["industrial_sites_timber_operating_mines_representative_count"] = (
            row.get("timber_facilities_count", 0) + row.get("operating_major_mines_representative_count", 0)
        )
        row["industrial_sites_timber_operating_mines_oil_unique_count"] = (
            row.get("timber_facilities_count", 0)
            + row.get("operating_major_mines_representative_count", 0)
            + row.get("oil_unique_field_names_count", 0)
        )
        row["industrial_sites_timber_operating_mines_gas_unique_count"] = (
            row.get("timber_facilities_count", 0)
            + row.get("operating_major_mines_representative_count", 0)
            + row.get("gas_unique_field_names_count", 0)
        )
        row["industrial_sites_timber_operating_mines_oil_gas_unique_count"] = (
            row.get("timber_facilities_count", 0)
            + row.get("operating_major_mines_representative_count", 0)
            + row.get("oil_gas_unique_field_names_count", 0)
        )


def iter_geojson_page_features(pages_dir):
    if not pages_dir.exists():
        return
    for page_path in sorted(pages_dir.glob("page-*.geojson")):
        collection = load_geojson(page_path)
        for feature in collection.get("features", []):
            yield feature


def iter_dra_records(layer_name, batch_size=50_000):
    source_id = next((key for key, value in DRA_GDB_LAYERS.items() if value == layer_name), None)
    parquet_path = DRA_PARQUET_FILES.get(source_id) if source_id else None
    if parquet_path and parquet_path.exists():
        parquet_file = pq.ParquetFile(parquet_path)
        for batch in parquet_file.iter_batches(batch_size=batch_size, columns=["length_2d_m", "geometry_wkb"]):
            lengths = batch.column("length_2d_m").to_pylist()
            geometries = shapely.from_wkb(batch.column("geometry_wkb").to_pylist())
            for geom, length_2d in zip(geometries, lengths):
                if geom is not None and not geom.is_empty:
                    yield clean_geometry(geom), length_2d
        return

    if not DRA_GDB_PATH.exists():
        return
    info = pyogrio.read_info(DRA_GDB_PATH, layer=layer_name)
    feature_count = int(info["features"])
    for offset in range(0, feature_count, batch_size):
        _metadata, table = pyogrio.read_arrow(
            DRA_GDB_PATH,
            layer=layer_name,
            columns=["LENGTH_2D"],
            skip_features=offset,
            max_features=batch_size,
        )
        lengths = table["LENGTH_2D"].to_pylist()
        for geom, length_2d in zip(shapely.from_wkb(table["geometry"].to_pylist()), lengths):
            if geom is not None and not geom.is_empty:
                yield clean_geometry(geom), length_2d


def linear_source_ready(source_id):
    pages_dir = LINEAR_SOURCES[source_id]
    return pages_dir.exists() and (pages_dir.parent / "manifest.json").exists()


def line_feature_includes_new_clearing(feature):
    clearing = str(feature.get("properties", {}).get("CLEARING", "")).strip().upper()
    return clearing != "EXIST"


def add_linear_length_metrics(rows, lhas):
    lha_geoms = [lha["geometry_albers"] for lha in lhas]
    tree = STRtree(lha_geoms)

    fields = []
    for source_id in LINEAR_SOURCES:
        fields.extend(
            [
                f"{source_id}_length_km",
                f"{source_id}_km_per_sq_km",
            ]
        )
    for source_id in DRA_GDB_LAYERS:
        fields.extend(
            [
                f"{source_id}_length_km",
                f"{source_id}_km_per_sq_km",
            ]
        )
    fields.extend(
        [
            "bcer_linear_footprint_length_km",
            "bcer_linear_footprint_km_per_sq_km",
            "bcer_linear_footprint_new_geophysical_plans_length_km",
            "bcer_linear_footprint_new_geophysical_plans_km_per_sq_km",
            "paper_available_linear_footprint_length_km",
            "paper_available_linear_footprint_km_per_sq_km",
            "paper_available_plus_dra_linear_footprint_length_km",
            "paper_available_plus_dra_linear_footprint_km_per_sq_km",
            "paper_dedup_linear_footprint_length_km",
            "paper_dedup_linear_footprint_km_per_sq_km",
            "forest_tenure_road_sections_not_within_1km_dra_length_km",
            "forest_tenure_road_sections_not_within_1km_dra_km_per_sq_km",
        ]
    )
    for row in rows.values():
        for field in fields:
            row[field] = 0

    for source_id, pages_dir in LINEAR_SOURCES.items():
        if not linear_source_ready(source_id):
            continue
        source_length_field = f"{source_id}_length_km"
        for feature in iter_geojson_page_features(pages_dir):
            geom = clean_geometry(shape(feature["geometry"]))
            if geom.is_empty:
                continue
            for index in tree.query(geom):
                lha_geom = lha_geoms[int(index)]
                if not lha_geom.intersects(geom):
                    continue
                try:
                    length_km = lha_geom.intersection(geom).length / 1000
                except Exception:
                    length_km = lha_geom.intersection(make_valid(geom)).length / 1000
                if length_km <= 0:
                    continue
                lha = lhas[int(index)]
                row = rows[lha["lha_code"]]
                row[source_length_field] += length_km
                if source_id.startswith("bcer_"):
                    row["bcer_linear_footprint_length_km"] += length_km
                if source_id.startswith("bcer_") and (
                    source_id != "bcer_geophysical_final_plans" or line_feature_includes_new_clearing(feature)
                ):
                    row["bcer_linear_footprint_new_geophysical_plans_length_km"] += length_km
                if source_id != "bcgw_digital_road_atlas_mpar":
                    row["paper_available_linear_footprint_length_km"] += length_km
                row["paper_available_plus_dra_linear_footprint_length_km"] += length_km

    add_dra_gdb_length_metrics(rows, lhas, lha_geoms, tree)
    add_forest_road_dra_dedup_metrics(rows, lhas)

    for row in rows.values():
        area = row["area_sq_km"]
        for source_id in LINEAR_SOURCES:
            length_field = f"{source_id}_length_km"
            density_field = f"{source_id}_km_per_sq_km"
            row[length_field] = round(row[length_field], 6)
            row[density_field] = round(row[length_field] / area, 6) if area else None
        for source_id in DRA_GDB_LAYERS:
            length_field = f"{source_id}_length_km"
            density_field = f"{source_id}_km_per_sq_km"
            row[length_field] = round(row[length_field], 6)
            row[density_field] = round(row[length_field] / area, 6) if area else None
        row["bcer_linear_footprint_length_km"] = round(row["bcer_linear_footprint_length_km"], 6)
        row["bcer_linear_footprint_km_per_sq_km"] = (
            round(row["bcer_linear_footprint_length_km"] / area, 6) if area else None
        )
        row["bcer_linear_footprint_new_geophysical_plans_length_km"] = round(
            row["bcer_linear_footprint_new_geophysical_plans_length_km"], 6
        )
        row["bcer_linear_footprint_new_geophysical_plans_km_per_sq_km"] = (
            round(row["bcer_linear_footprint_new_geophysical_plans_length_km"] / area, 6) if area else None
        )
        row["paper_available_linear_footprint_length_km"] = round(row["paper_available_linear_footprint_length_km"], 6)
        row["paper_available_linear_footprint_km_per_sq_km"] = (
            round(row["paper_available_linear_footprint_length_km"] / area, 6) if area else None
        )
        row["paper_available_plus_dra_linear_footprint_length_km"] = round(
            row["paper_available_plus_dra_linear_footprint_length_km"], 6
        )
        row["paper_available_plus_dra_linear_footprint_km_per_sq_km"] = (
            round(row["paper_available_plus_dra_linear_footprint_length_km"] / area, 6) if area else None
        )
        row["forest_tenure_road_sections_not_within_1km_dra_length_km"] = round(
            row["forest_tenure_road_sections_not_within_1km_dra_length_km"], 6
        )
        row["forest_tenure_road_sections_not_within_1km_dra_km_per_sq_km"] = (
            round(row["forest_tenure_road_sections_not_within_1km_dra_length_km"] / area, 6) if area else None
        )
        row["paper_dedup_linear_footprint_length_km"] = round(row["paper_dedup_linear_footprint_length_km"], 6)
        row["paper_dedup_linear_footprint_km_per_sq_km"] = (
            round(row["paper_dedup_linear_footprint_length_km"] / area, 6) if area else None
        )


def add_dra_gdb_length_metrics(rows, lhas, lha_geoms, lha_tree):
    if not DRA_GDB_PATH.exists():
        return
    for source_id, layer_name in DRA_GDB_LAYERS.items():
        source_length_field = f"{source_id}_length_km"
        for geom, source_length_m in iter_dra_records(layer_name):
            point = geom.representative_point()
            for index in lha_tree.query(point):
                lha_geom = lha_geoms[int(index)]
                if not lha_geom.covers(point):
                    continue
                length_km = (float(source_length_m) / 1000) if source_length_m not in (None, "") else geom.length / 1000
                if length_km <= 0:
                    continue
                row = rows[lhas[int(index)]["lha_code"]]
                row[source_length_field] += length_km
                if source_id == "bcgw_digital_road_atlas_mpar":
                    row["paper_available_plus_dra_linear_footprint_length_km"] += length_km


def add_forest_road_dra_dedup_metrics(rows, lhas):
    forest_source = "bcgw_forest_tenure_road_sections"
    for row in rows.values():
        row["forest_tenure_road_sections_not_within_1km_dra_length_km"] = row.get(
            "bcgw_forest_tenure_road_sections_length_km", 0
        )
        row["paper_dedup_linear_footprint_length_km"] = row.get("paper_available_plus_dra_linear_footprint_length_km", 0)

    if not (linear_source_ready(forest_source) and DRA_GDB_PATH.exists()):
        return

    lha_geoms = [lha["geometry_albers"] for lha in lhas]
    dra_geoms = [geom for geom, _source_length_m in iter_dra_records(DRA_GDB_LAYERS["bcgw_digital_road_atlas_mpar"])]
    dra_tree = STRtree(dra_geoms) if dra_geoms else None
    lha_tree = STRtree(lha_geoms)
    dedup_lengths = {lha["lha_code"]: 0 for lha in lhas}

    for feature in iter_geojson_page_features(LINEAR_SOURCES[forest_source]):
        geom = clean_geometry(shape(feature["geometry"]))
        if geom.is_empty:
            continue
        for index in lha_tree.query(geom):
            lha = lhas[int(index)]
            lha_geom = lha_geoms[int(index)]
            if not lha_geom.intersects(geom):
                continue
            clipped = clean_geometry(lha_geom.intersection(geom))
            if clipped.is_empty:
                continue
            if dra_tree is None:
                dedup_lengths[lha["lha_code"]] += clipped.length / 1000
                continue
            if len(dra_tree.query(clipped, predicate="dwithin", distance=1000)) == 0:
                dedup_lengths[lha["lha_code"]] += clipped.length / 1000

    for lha in lhas:
        row = rows[lha["lha_code"]]
        original_forest = row.get("bcgw_forest_tenure_road_sections_length_km", 0)
        kept_forest = dedup_lengths[lha["lha_code"]]
        row["forest_tenure_road_sections_not_within_1km_dra_length_km"] = kept_forest
        row["paper_dedup_linear_footprint_length_km"] = (
            row.get("paper_available_plus_dra_linear_footprint_length_km", 0)
            - original_forest
            + kept_forest
        )


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
    comparisons = [
        ("remediation_sites", "remediation_sites_count"),
        ("remediation_sites", "remediation_sites_site_id_lte_23504_count"),
        ("industrial_sites", "industrial_sites_proxy_count"),
        ("industrial_sites", "industrial_sites_operating_proxy_count"),
        ("industrial_sites", "industrial_sites_2022_proxy_count"),
        ("industrial_sites", "industrial_sites_operating_2022_proxy_count"),
        ("industrial_sites", "industrial_sites_timber_operating_mines_representative_count"),
        ("industrial_sites", "industrial_sites_timber_operating_mines_oil_unique_count"),
        ("industrial_sites", "industrial_sites_timber_operating_mines_gas_unique_count"),
        ("industrial_sites", "industrial_sites_timber_operating_mines_oil_gas_unique_count"),
        ("linear_footprint", "bcer_geophysical_lines_km_per_sq_km"),
        ("linear_footprint", "bcer_geophysical_final_plans_km_per_sq_km"),
        ("linear_footprint", "bcer_pipeline_segments_km_per_sq_km"),
        ("linear_footprint", "bcer_linear_footprint_km_per_sq_km"),
        ("linear_footprint", "bcer_linear_footprint_new_geophysical_plans_km_per_sq_km"),
        ("linear_footprint", "bcgw_forest_tenure_road_sections_km_per_sq_km"),
        ("linear_footprint", "bcgw_railway_track_km_per_sq_km"),
        ("linear_footprint", "bcgw_transmission_lines_km_per_sq_km"),
        ("linear_footprint", "paper_available_linear_footprint_km_per_sq_km"),
        ("linear_footprint", "bcgw_digital_road_atlas_mpar_km_per_sq_km"),
        ("linear_footprint", "bcgw_digital_road_atlas_dpar_km_per_sq_km"),
        ("linear_footprint", "paper_available_plus_dra_linear_footprint_km_per_sq_km"),
        ("linear_footprint", "forest_tenure_road_sections_not_within_1km_dra_km_per_sq_km"),
        ("linear_footprint", "paper_dedup_linear_footprint_km_per_sq_km"),
        ("wildfire_burn_area", "wildfire_all_years_area_percent"),
        ("wildfire_burn_area", "wildfire_2001_2010_area_percent"),
        ("wildfire_burn_area", "wildfire_2008_2017_area_percent"),
        ("wildfire_burn_area", "wildfire_2010_2019_area_percent"),
        ("wildfire_burn_area", "wildfire_2011_2020_area_percent"),
        ("wildfire_burn_area", "wildfire_2015_2024_area_percent"),
    ]
    output = []
    for row in rows:
        shiny_row = shiny.get(row["lha_name"], {})
        for shiny_field, rebuilt_field in comparisons:
            shiny_value = number(shiny_row.get(shiny_field))
            rebuilt_value = number(row.get(rebuilt_field))
            if shiny_value is None or rebuilt_value is None:
                continue
            output.append(
                {
                    "lha_name": row["lha_name"],
                    "shiny_field": shiny_field,
                    "rebuilt_field": rebuilt_field,
                    "shiny_value": shiny_value,
                    "rebuilt_value": rebuilt_value,
                    "difference": round(rebuilt_value - shiny_value, 6),
                    "absolute_difference": round(abs(rebuilt_value - shiny_value), 6),
                }
            )
    return output


def summarize_comparison(comparison_rows):
    grouped = defaultdict(list)
    for row in comparison_rows:
        grouped[(row["shiny_field"], row["rebuilt_field"])].append(row)
    summaries = []
    for (shiny_field, rebuilt_field), rows in sorted(grouped.items()):
        abs_diffs = [row["absolute_difference"] for row in rows]
        shiny_values = [row["shiny_value"] for row in rows]
        rebuilt_values = [row["rebuilt_value"] for row in rows]
        summaries.append(
            {
                "shiny_field": shiny_field,
                "rebuilt_field": rebuilt_field,
                "rows": len(rows),
                "mean_absolute_difference": round(sum(abs_diffs) / len(abs_diffs), 6),
                "max_absolute_difference": round(max(abs_diffs), 6),
                "pearson_r": pearson(shiny_values, rebuilt_values),
            }
        )
    return summaries


def pearson(xs, ys):
    n = len(xs)
    if n < 2:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx <= 0 or vy <= 0:
        return None
    return round(cov / math.sqrt(vx * vy), 6)


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
    rows_by_lha = init_rows(lhas)
    add_point_counts(rows_by_lha, lhas)
    add_polygon_aggregates(rows_by_lha, lhas)
    add_linear_length_metrics(rows_by_lha, lhas)

    rows = [rows_by_lha[key] for key in sorted(rows_by_lha)]
    comparisons = compare_to_shiny(rows)
    summary = summarize_comparison(comparisons)

    write_csv(OUTPUT_DIR / "lha-spatial-indicators.csv", rows)
    write_csv(OUTPUT_DIR / "shiny-comparison-long.csv", comparisons)
    write_csv(OUTPUT_DIR / "shiny-comparison-summary.csv", summary)
    (OUTPUT_DIR / "lha-spatial-indicators.json").write_text(json.dumps(rows, indent=2) + "\n")
    (OUTPUT_DIR / "shiny-comparison-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "sourceLayers": {key: str(path.relative_to(SCRIPT_DIR)) for key, path in SOURCES.items()},
                "lhaBoundary": str(LHA_PATH.relative_to(PGMAPS_ROOT)),
                "validationTarget": str(SHINY_PATH.relative_to(SCRIPT_DIR)),
                "notes": [
                    "Point sources are assigned by point-in-LHA.",
                    "Polygon sources are intersected in EPSG:3005 and area percentages use LHA land/water polygon area from the boundary file.",
                    "Industrial sites is a proxy sum of timber facilities, major mine area intersections, and oil/gas field intersections; NPRI and the exact Shiny source are not included yet.",
                    "BCER/BCGW paged GeoJSON and local Digital Road Atlas FileGDB candidates are summarized as line km per LHA square km.",
                    "The de-duplicated linear-footprint candidate excludes forest-tenure road sections within 1 km of DRA MPAR roads.",
                    "Wildfire burn-area is emitted for several year windows to identify which period best matches the Shiny table.",
                ],
            },
            indent=2,
        )
        + "\n"
    )
    print(f"BCEnviroScreen spatial rebuild: wrote {OUTPUT_DIR.relative_to(PGMAPS_ROOT)}")


if __name__ == "__main__":
    main()
