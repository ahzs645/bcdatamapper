#!/usr/bin/env python3

import csv
import json
import math
import os
import re
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import requests
from pyproj import Transformer
from shapely.geometry import Point, shape
from shapely.ops import transform
from shapely.prepared import prep
from shapely.validation import make_valid


SCRIPT_DIR = Path(__file__).resolve().parent
PGMAPS_ROOT = Path(os.environ.get("PGMAPS_ROOT", SCRIPT_DIR.parents[3])).resolve()
OUTPUT_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-traffic-lha"
RAW_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "raw-rebuild-seed" / "compact" / "traffic-data-program"
LHA_PATH = PGMAPS_ROOT / "public" / "data" / "boundaries" / "BCMoH" / "local_health_areas.json"
SHINY_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "official-shiny-table" / "lha-indicators.csv"
CD_TARGETS_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "cd-attributed-targets" / "lha-cd-attributed-targets.csv"
TMS_REPORT_AADT_PATH = RAW_DIR / "tdp-tms-site-report-annual-aadt.csv"
UTV_REPORT_AADT_PATH = RAW_DIR / "tdp-utv-segment-report-aadt.csv"
WFS_URL = "https://maps.th.gov.bc.ca/geoV05/ows"
UTV_TYPENAME = "tig:TIG_UTV_SEGMENT_EXT"
TMP_TYPENAME = "tig:TIG_TMP_GEOM_EXT_V"
TMS_TYPENAME = "tig:TIG_TMS_GEOMETRY_EXT_V"
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
        geom_wgs84 = clean_geometry(shape(feature["geometry"]))
        geom = clean_geometry(transform(TO_BC_ALBERS, geom_wgs84))
        lhas.append(
            {
                **lha_info(feature),
                "geometry_wgs84": geom_wgs84,
                "prepared_wgs84": prep(geom_wgs84),
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


def download_tmp_points():
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    output_path = RAW_DIR / "tig-tmp-geom-ext-v.geojson"
    if output_path.exists() and output_path.stat().st_size > 1000:
        return json.loads(output_path.read_text())

    params = {
        "service": "WFS",
        "version": "2.0.0",
        "request": "GetFeature",
        "typeName": TMP_TYPENAME,
        "outputFormat": "JSON",
        "srsName": "EPSG:4326",
        "count": 10000,
    }
    response = requests.get(WFS_URL, params=params, timeout=120)
    response.raise_for_status()
    data = response.json()
    output_path.write_text(json.dumps(data, separators=(",", ":")) + "\n")
    return data


def download_tms_sites():
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    output_path = RAW_DIR / "tig-tms-geometry-ext-v.geojson"
    if output_path.exists() and output_path.stat().st_size > 1000:
        return json.loads(output_path.read_text())

    params = {
        "service": "WFS",
        "version": "2.0.0",
        "request": "GetFeature",
        "typeName": TMS_TYPENAME,
        "outputFormat": "JSON",
        "srsName": "EPSG:4326",
        "count": 10000,
    }
    response = requests.get(WFS_URL, params=params, timeout=120)
    response.raise_for_status()
    data = response.json()
    output_path.write_text(json.dumps(data, separators=(",", ":")) + "\n")
    return data


def load_lha_primary_cd():
    if not CD_TARGETS_PATH.exists():
        return {}
    mapping = {}
    for row in read_csv(CD_TARGETS_PATH):
        if row.get("lha_name") and row.get("cd_code"):
            mapping[row["lha_name"]] = str(row["cd_code"])
    return mapping


def load_tms_report_rows():
    if not TMS_REPORT_AADT_PATH.exists():
        return []
    rows = []
    for row in read_csv(TMS_REPORT_AADT_PATH):
        aadt_2018 = numeric(row.get("aadt_2018"))
        lon = numeric(row.get("lon"))
        lat = numeric(row.get("lat"))
        if aadt_2018 is None or lon is None or lat is None:
            continue
        rows.append({**row, "aadt_2018": aadt_2018, "lon": lon, "lat": lat})
    return rows


def load_utv_report_rows():
    if not UTV_REPORT_AADT_PATH.exists():
        return {}
    rows = {}
    for row in read_csv(UTV_REPORT_AADT_PATH):
        segment_number = str(row.get("segment_number") or "").strip()
        aadt_2018 = numeric(row.get("aadt_2018"))
        if not segment_number or aadt_2018 is None:
            continue
        rows[segment_number] = {**row, "aadt_2018": aadt_2018}
    return rows


def tms_description(row):
    return " ".join(
        str(row.get(key) or "")
        for key in [
            "site_name",
            "site_description",
            "description",
            "highway_description",
            "location_description",
            "station_description",
            "road_name",
        ]
    )


def is_ramp_or_turn_site(row):
    description = tms_description(row).lower()
    if "ramp" in description:
        return True
    return bool(re.search(r"\b(nb|sb|eb|wb)\s+to\b", description))


def is_interchange_site(row):
    description = tms_description(row).lower()
    return bool(re.search(r"\bi/c\b|\bic\b|interchange", description))


def build_lha_rows(lhas, segments, tmp_points):
    rows = {
        lha["lha_code"]: {
            key: lha[key]
            for key in ["lha_code", "lha_name", "hsda_code", "hsda_name", "ha_code", "ha_name", "area_sq_km"]
        }
        for lha in lhas
    }
    totals = defaultdict(lambda: {"aadt_km": 0.0, "aadt_m": 0.0, "segment_km": 0.0, "segments": 0})
    point_totals = defaultdict(lambda: {"aadt_sum": 0.0, "aadt_max": None, "points": 0})

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

    for feature in tmp_points.get("features", []):
        props = feature.get("properties", {})
        aadt = numeric(props.get("AADT"))
        if aadt is None:
            continue
        coords = feature.get("geometry", {}).get("coordinates")
        if not coords or len(coords) < 2:
            continue
        point = Point(coords[0], coords[1])
        for lha in lhas:
            if not lha["prepared_wgs84"].covers(point):
                continue
            bucket = point_totals[lha["lha_code"]]
            bucket["aadt_sum"] += aadt
            bucket["aadt_max"] = aadt if bucket["aadt_max"] is None else max(bucket["aadt_max"], aadt)
            bucket["points"] += 1
            break

    for lha in lhas:
        row = rows[lha["lha_code"]]
        total = totals[lha["lha_code"]]
        point_total = point_totals[lha["lha_code"]]
        area = row["area_sq_km"]
        row["traffic_data_program_utv_aadt_km_per_sq_km"] = round(total["aadt_km"] / area, 6) if area else None
        row["traffic_data_program_utv_aadt_m_per_sq_km"] = round(total["aadt_m"] / area, 6) if area else None
        row["traffic_data_program_utv_segment_km_per_sq_km"] = round(total["segment_km"] / area, 6) if area else None
        row["traffic_data_program_utv_segment_count"] = total["segments"]
        row["traffic_data_program_tmp_aadt_sum"] = round(point_total["aadt_sum"], 6)
        row["traffic_data_program_tmp_aadt_max"] = point_total["aadt_max"]
        row["traffic_data_program_tmp_point_count"] = point_total["points"]
        row["traffic_data_program_tmp_aadt_sum_per_sq_km"] = round(point_total["aadt_sum"] / area, 6) if area else None
        row["traffic_data_program_tmp_aadt_max_per_sq_km"] = (
            round(point_total["aadt_max"] / area, 6) if area and point_total["aadt_max"] is not None else None
        )
    return [rows[key] for key in sorted(rows)]


def add_tms_report_candidates(rows, lhas, tms_report_rows, lha_primary_cd):
    if not tms_report_rows:
        return

    by_code = {row["lha_code"]: row for row in rows}
    assigned_rows = []

    for report_row in tms_report_rows:
        point = Point(report_row["lon"], report_row["lat"])
        containing_lha = None
        for lha in lhas:
            if lha["prepared_wgs84"].covers(point):
                containing_lha = lha
                break
        if not containing_lha:
            continue

        cd_code = lha_primary_cd.get(containing_lha["lha_name"])
        assigned_rows.append(
            {
                **report_row,
                "lha_code": containing_lha["lha_code"],
                "lha_name": containing_lha["lha_name"],
                "cd_code": cd_code,
                "type_code": str(report_row.get("type_code") or "").strip().upper(),
                "status_code": str(report_row.get("status_code") or "").strip().upper(),
                "utv_segment_ext_id": str(report_row.get("utv_segment_ext_id") or "").strip(),
                "is_ramp_or_turn_site": is_ramp_or_turn_site(report_row),
                "is_interchange_site": is_interchange_site(report_row),
            }
        )

    def max_per_segment(selected_rows, segment_only=False):
        grouped = {}
        for index, row in enumerate(selected_rows):
            segment_id = row["utv_segment_ext_id"]
            if segment_id:
                key = ("segment", segment_id)
            elif segment_only:
                continue
            else:
                key = ("site", str(row.get("pdb_site_id") or row.get("site_id") or row.get("site_code") or index))
            current = grouped.get(key)
            if current is None or row["aadt_2018"] > current["aadt_2018"]:
                grouped[key] = row
        return list(grouped.values())

    variants = {
        "all": assigned_rows,
        "active": [row for row in assigned_rows if row["status_code"] in {"", "A"}],
        "permanent": [row for row in assigned_rows if row["type_code"] == "P"],
        "permanent_wim": [row for row in assigned_rows if row["type_code"] in {"P", "W"}],
        "short": [row for row in assigned_rows if row["type_code"] == "S"],
        "no_ramp_turn": [row for row in assigned_rows if not row["is_ramp_or_turn_site"]],
        "no_interchange_ramp_turn": [
            row for row in assigned_rows if not row["is_ramp_or_turn_site"] and not row["is_interchange_site"]
        ],
    }
    variants["segment_max_all"] = max_per_segment(variants["all"])
    variants["segment_max_segment_only"] = max_per_segment(variants["all"], segment_only=True)
    variants["segment_max_no_ramp_turn"] = max_per_segment(variants["no_ramp_turn"])
    variants["segment_max_no_interchange_ramp_turn"] = max_per_segment(variants["no_interchange_ramp_turn"])
    variants["segment_max_permanent"] = max_per_segment(variants["permanent"])

    def grouped_values(selected_rows):
        lha_values = defaultdict(list)
        cd_values = defaultdict(list)
        for row in selected_rows:
            lha_values[row["lha_code"]].append(row["aadt_2018"])
            if row.get("cd_code"):
                cd_values[row["cd_code"]].append(row["aadt_2018"])
        return lha_values, cd_values

    def apply_group(row, field_prefix, values, area=None):
        if not values:
            row[f"{field_prefix}_aadt_sum"] = None
            row[f"{field_prefix}_aadt_max"] = None
            row[f"{field_prefix}_aadt_mean"] = None
            row[f"{field_prefix}_aadt_median"] = None
            row[f"{field_prefix}_site_count"] = None
            if area is not None:
                row[f"{field_prefix}_aadt_sum_per_sq_km"] = None
            return
        row[f"{field_prefix}_aadt_sum"] = round(sum(values), 6)
        row[f"{field_prefix}_aadt_max"] = max(values)
        row[f"{field_prefix}_aadt_mean"] = round(sum(values) / len(values), 6)
        row[f"{field_prefix}_aadt_median"] = round(statistics.median(values), 6)
        row[f"{field_prefix}_site_count"] = len(values)
        if area is not None:
            row[f"{field_prefix}_aadt_sum_per_sq_km"] = round(sum(values) / area, 6) if area else None

    variant_groups = {name: grouped_values(selected_rows) for name, selected_rows in variants.items()}

    for lha in lhas:
        row = by_code[lha["lha_code"]]
        area = row["area_sq_km"]
        cd_code = lha_primary_cd.get(lha["lha_name"])
        for variant_name, (lha_values, cd_values) in variant_groups.items():
            prefix = f"traffic_data_program_tms_report_2018_{variant_name}"
            apply_group(row, f"{prefix}_lha", lha_values[lha["lha_code"]], area=area)
            apply_group(row, f"{prefix}_cd", cd_values[cd_code])

        for old_suffix, new_suffix in [
            ("lha_aadt_sum", "all_lha_aadt_sum"),
            ("lha_aadt_max", "all_lha_aadt_max"),
            ("lha_site_count", "all_lha_site_count"),
            ("lha_aadt_sum_per_sq_km", "all_lha_aadt_sum_per_sq_km"),
            ("cd_aadt_sum", "all_cd_aadt_sum"),
            ("cd_aadt_max", "all_cd_aadt_max"),
            ("cd_site_count", "all_cd_site_count"),
        ]:
            row[f"traffic_data_program_tms_report_2018_{old_suffix}"] = row[
                f"traffic_data_program_tms_report_2018_{new_suffix}"
            ]


def add_utv_report_candidates(rows, lhas, segments, utv_report_rows, lha_primary_cd):
    if not utv_report_rows:
        return

    by_code = {row["lha_code"]: row for row in rows}
    lha_intersection_values = defaultdict(list)
    lha_centroid_values = defaultdict(list)
    lha_aadt_km = defaultdict(float)
    cd_centroid_values = defaultdict(list)

    for feature in segments.get("features", []):
        props = feature.get("properties", {})
        segment_number = str(props.get("SEGMENT_NUMBER") or "").strip()
        report_row = utv_report_rows.get(segment_number)
        if not report_row:
            continue
        aadt = report_row["aadt_2018"]
        geom_wgs84 = clean_geometry(shape(feature["geometry"]))
        geom_albers = clean_geometry(transform(TO_BC_ALBERS, geom_wgs84))
        if geom_wgs84.is_empty or geom_albers.is_empty:
            continue

        point = geom_wgs84.representative_point()
        for lha in lhas:
            if not lha["prepared_wgs84"].covers(point):
                continue
            lha_centroid_values[lha["lha_code"]].append(aadt)
            cd_code = lha_primary_cd.get(lha["lha_name"])
            if cd_code:
                cd_centroid_values[cd_code].append(aadt)
            break

        for lha in lhas:
            if not bounds_intersect(lha["bounds"], geom_albers.bounds):
                continue
            intersection = clean_geometry(geom_albers.intersection(lha["geometry_albers"]))
            if intersection.is_empty or intersection.length <= 0:
                continue
            lha_intersection_values[lha["lha_code"]].append(aadt)
            lha_aadt_km[lha["lha_code"]] += aadt * (intersection.length / 1000)

    cd_from_lha_intersection_values = defaultdict(list)
    cd_from_lha_intersection_sum = defaultdict(float)
    cd_from_lha_aadt_km_sum = defaultdict(float)
    for lha in lhas:
        cd_code = lha_primary_cd.get(lha["lha_name"])
        if not cd_code:
            continue
        values = lha_intersection_values[lha["lha_code"]]
        if values:
            cd_from_lha_intersection_values[cd_code].extend(values)
            cd_from_lha_intersection_sum[cd_code] += sum(values)
        if lha_aadt_km.get(lha["lha_code"]):
            cd_from_lha_aadt_km_sum[cd_code] += lha_aadt_km[lha["lha_code"]]

    def apply_values(row, prefix, values, area=None):
        if not values:
            row[f"{prefix}_aadt_sum"] = None
            row[f"{prefix}_aadt_max"] = None
            row[f"{prefix}_aadt_mean"] = None
            row[f"{prefix}_aadt_median"] = None
            row[f"{prefix}_segment_count"] = None
            if area is not None:
                row[f"{prefix}_aadt_sum_per_sq_km"] = None
            return
        row[f"{prefix}_aadt_sum"] = round(sum(values), 6)
        row[f"{prefix}_aadt_max"] = max(values)
        row[f"{prefix}_aadt_mean"] = round(sum(values) / len(values), 6)
        row[f"{prefix}_aadt_median"] = round(statistics.median(values), 6)
        row[f"{prefix}_segment_count"] = len(values)
        if area is not None:
            row[f"{prefix}_aadt_sum_per_sq_km"] = round(sum(values) / area, 6) if area else None

    for lha in lhas:
        row = by_code[lha["lha_code"]]
        area = row["area_sq_km"]
        cd_code = lha_primary_cd.get(lha["lha_name"])
        apply_values(row, "traffic_data_program_utv_report_2018_lha_intersection", lha_intersection_values[lha["lha_code"]], area)
        apply_values(row, "traffic_data_program_utv_report_2018_lha_representative_point", lha_centroid_values[lha["lha_code"]], area)
        apply_values(row, "traffic_data_program_utv_report_2018_cd_representative_point", cd_centroid_values[cd_code])
        apply_values(row, "traffic_data_program_utv_report_2018_cd_from_lha_intersection", cd_from_lha_intersection_values[cd_code])
        row["traffic_data_program_utv_report_2018_lha_intersection_aadt_km"] = (
            round(lha_aadt_km[lha["lha_code"]], 6) if lha_aadt_km.get(lha["lha_code"]) else None
        )
        row["traffic_data_program_utv_report_2018_cd_from_lha_intersection_aadt_km"] = (
            round(cd_from_lha_aadt_km_sum[cd_code], 6) if cd_from_lha_aadt_km_sum.get(cd_code) else None
        )
        row["traffic_data_program_utv_report_2018_cd_from_lha_intersection_lha_sum"] = (
            round(cd_from_lha_intersection_sum[cd_code], 6) if cd_from_lha_intersection_sum.get(cd_code) else None
        )


def build_utv_report_diagnostics(lhas, segments, utv_report_rows, lha_primary_cd):
    if not utv_report_rows:
        return [], []

    shiny = {row["lha_name"]: row for row in read_csv(SHINY_PATH)}
    segment_rows = []
    cd_totals = defaultdict(lambda: {"aadt_sum": 0.0, "segment_count": 0, "lhas": set(), "shiny_values": set()})

    for feature in segments.get("features", []):
        props = feature.get("properties", {})
        segment_number = str(props.get("SEGMENT_NUMBER") or "").strip()
        report_row = utv_report_rows.get(segment_number)
        if not report_row:
            continue

        geom_wgs84 = clean_geometry(shape(feature["geometry"]))
        if geom_wgs84.is_empty:
            continue
        point = geom_wgs84.representative_point()
        containing_lha = None
        for lha in lhas:
            if lha["prepared_wgs84"].covers(point):
                containing_lha = lha
                break
        if not containing_lha:
            continue

        cd_code = lha_primary_cd.get(containing_lha["lha_name"])
        aadt = report_row["aadt_2018"]
        shiny_value = numeric(shiny.get(containing_lha["lha_name"], {}).get("traffic_density"))
        segment_rows.append(
            {
                "cd_code": cd_code,
                "lha_name": containing_lha["lha_name"],
                "segment_number": segment_number,
                "aadt_2018": aadt,
                "sadt_2018": report_row.get("sadt_2018"),
                "traffic_pattern_type_ext_code": report_row.get("traffic_pattern_type_ext_code"),
                "status_type_ext_code": report_row.get("status_type_ext_code"),
                "description": report_row.get("description"),
                "shiny_lha_traffic_density": shiny_value,
            }
        )
        if cd_code:
            bucket = cd_totals[cd_code]
            bucket["aadt_sum"] += aadt
            bucket["segment_count"] += 1
            bucket["lhas"].add(containing_lha["lha_name"])
            if shiny_value is not None:
                bucket["shiny_values"].add(shiny_value)

    summary_rows = []
    for cd_code, bucket in sorted(cd_totals.items()):
        shiny_values = sorted(bucket["shiny_values"])
        representative_shiny = shiny_values[0] if len(shiny_values) == 1 else None
        summary_rows.append(
            {
                "cd_code": cd_code,
                "utv_2018_aadt_sum": round(bucket["aadt_sum"], 6),
                "segment_count": bucket["segment_count"],
                "lha_count": len(bucket["lhas"]),
                "lha_names": "; ".join(sorted(bucket["lhas"])),
                "shiny_traffic_values": "; ".join(str(value) for value in shiny_values),
                "single_shiny_traffic_value": representative_shiny,
                "difference_from_single_shiny": (
                    round(bucket["aadt_sum"] - representative_shiny, 6) if representative_shiny is not None else None
                ),
            }
        )
    return segment_rows, summary_rows


def compare_to_shiny(rows):
    shiny = {row["lha_name"]: row for row in read_csv(SHINY_PATH)}
    base_candidates = [
        "traffic_data_program_utv_aadt_km_per_sq_km",
        "traffic_data_program_utv_aadt_m_per_sq_km",
        "traffic_data_program_utv_segment_km_per_sq_km",
        "traffic_data_program_utv_segment_count",
        "traffic_data_program_tmp_aadt_sum",
        "traffic_data_program_tmp_aadt_max",
        "traffic_data_program_tmp_point_count",
        "traffic_data_program_tmp_aadt_sum_per_sq_km",
        "traffic_data_program_tmp_aadt_max_per_sq_km",
        "traffic_data_program_tms_report_2018_lha_aadt_sum",
        "traffic_data_program_tms_report_2018_lha_aadt_max",
        "traffic_data_program_tms_report_2018_lha_site_count",
        "traffic_data_program_tms_report_2018_lha_aadt_sum_per_sq_km",
        "traffic_data_program_tms_report_2018_cd_aadt_sum",
        "traffic_data_program_tms_report_2018_cd_aadt_max",
        "traffic_data_program_tms_report_2018_cd_site_count",
    ]
    candidates = []
    for candidate in base_candidates:
        if candidate not in candidates:
            candidates.append(candidate)
    for row in rows:
        for key in row:
            if (
                key.startswith("traffic_data_program_tms_report_2018_")
                or key.startswith("traffic_data_program_utv_report_2018_")
            ) and key not in candidates:
                candidates.append(key)
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
    tmp_points = download_tmp_points()
    tms_sites = download_tms_sites()
    tms_report_rows = load_tms_report_rows()
    utv_report_rows = load_utv_report_rows()
    lha_primary_cd = load_lha_primary_cd()
    rows = build_lha_rows(lhas, segments, tmp_points)
    add_utv_report_candidates(rows, lhas, segments, utv_report_rows, lha_primary_cd)
    add_tms_report_candidates(rows, lhas, tms_report_rows, lha_primary_cd)
    utv_segment_rows, utv_cd_summary_rows = build_utv_report_diagnostics(lhas, segments, utv_report_rows, lha_primary_cd)
    long_rows, summary_rows = compare_to_shiny(rows)

    write_csv(OUTPUT_DIR / "lha-traffic-candidates.csv", rows)
    write_csv(OUTPUT_DIR / "shiny-comparison-long.csv", long_rows)
    write_csv(OUTPUT_DIR / "shiny-comparison-summary.csv", summary_rows)
    write_csv(OUTPUT_DIR / "utv-report-2018-cd-segments.csv", utv_segment_rows)
    write_csv(OUTPUT_DIR / "utv-report-2018-cd-summary.csv", utv_cd_summary_rows)
    (OUTPUT_DIR / "lha-traffic-candidates.json").write_text(json.dumps(rows, indent=2) + "\n")
    (OUTPUT_DIR / "shiny-comparison-summary.json").write_text(json.dumps(summary_rows, indent=2) + "\n")
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "source": {
                    "name": "BC Ministry of Transportation and Transit Traffic Data Program WFS layers",
                    "url": WFS_URL,
                    "layers": [
                        {
                            "name": "Uniform Traffic Volume segments",
                            "typeName": UTV_TYPENAME,
                            "cachedGeojson": str((RAW_DIR / "tig-utv-segment-ext.geojson").relative_to(SCRIPT_DIR)),
                            "features": len(segments.get("features", [])),
                        },
                        {
                            "name": "Traffic Measurement Point",
                            "typeName": TMP_TYPENAME,
                            "cachedGeojson": str((RAW_DIR / "tig-tmp-geom-ext-v.geojson").relative_to(SCRIPT_DIR)),
                            "features": len(tmp_points.get("features", [])),
                        },
                        {
                            "name": "Traffic Measurement Site",
                            "typeName": TMS_TYPENAME,
                            "cachedGeojson": str((RAW_DIR / "tig-tms-geometry-ext-v.geojson").relative_to(SCRIPT_DIR)),
                            "features": len(tms_sites.get("features", [])),
                        },
                    ],
                    "tmsAnnualAadtCsv": str(TMS_REPORT_AADT_PATH.relative_to(SCRIPT_DIR)) if TMS_REPORT_AADT_PATH.exists() else None,
                    "tmsAnnualAadtRows": len(tms_report_rows),
                    "utvAnnualAadtCsv": str(UTV_REPORT_AADT_PATH.relative_to(SCRIPT_DIR)) if UTV_REPORT_AADT_PATH.exists() else None,
                    "utvAnnualAadtRows": len(utv_report_rows),
                },
                "method": "Clip UTV segments to LHA in EPSG:3005 and aggregate MAP_RENDERING_AADT weighted by clipped segment length. Assign Traffic Measurement Point AADT values to containing LHA and summarize sum/max/count. When staged UTV segment-report annual AADT CSV is available, aggregate 2018 UTV segment AADT by LHA intersection and representative-point Census Division. When staged TMS annual AADT report CSV is available, assign 2018 site-report AADT to LHA and to the LHA primary Census Division benchmark group.",
                "outputs": {
                    "candidatesCsv": "lha-traffic-candidates.csv",
                    "comparisonSummaryCsv": "shiny-comparison-summary.csv",
                    "comparisonLongCsv": "shiny-comparison-long.csv",
                    "utvReportSegmentsCsv": "utv-report-2018-cd-segments.csv",
                    "utvReportCdSummaryCsv": "utv-report-2018-cd-summary.csv",
                },
            },
            indent=2,
        )
        + "\n"
    )
    print(f"BCEnviroScreen traffic LHA: wrote {OUTPUT_DIR.relative_to(PGMAPS_ROOT)}")


if __name__ == "__main__":
    main()
