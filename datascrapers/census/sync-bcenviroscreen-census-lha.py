#!/usr/bin/env python3

import csv
import json
import os
import re
import sys
import time
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

import requests
import shapefile
from pyproj import Transformer
from shapely.geometry import shape
from shapely.prepared import prep


SCRIPT_DIR = Path(__file__).resolve().parent
PGMAPS_ROOT = Path(os.environ.get("PGMAPS_ROOT", SCRIPT_DIR.parents[3])).resolve()
OUTPUT_DIR = SCRIPT_DIR / "output" / "bcenviroscreen-census-lha"
RAW_DIR = OUTPUT_DIR / "raw"
LHA_BOUNDARIES = PGMAPS_ROOT / "public" / "data" / "boundaries" / "BCMoH" / "local_health_areas.json"
CENSUSMAPPER_BASE = "https://censusmapper.ca/api/v1"
DEFAULT_API_KEY = "CensusMapper_c36f7ab0a43132b3d0b8e83538c4de57"
LAMBERT_TO_WGS84 = Transformer.from_crs("EPSG:3347", "EPSG:4326", always_xy=True)


DATASETS = {
    "2016": {
        "dataset": "CA16",
        "census_year": 2016,
        "source_label": "2016 Census Profile, Statistics Canada regional CSV download",
        "download_url": "https://www12.statcan.gc.ca/census-recensement/2016/dp-pd/prof/details/download-telecharger/comp/GetFile.cfm?Lang=E&FILETYPE=CSV&GEONO=044_BRITISH_COLUMBIA",
        "boundary_url": "https://www12.statcan.gc.ca/census-recensement/2011/geo/bound-limit/files-fichiers/2016/lda_000b16a_e.zip",
        "zip_name": "statcan-2016-bc-profile-da.zip",
        "boundary_zip_name": "statcan-2016-da-boundaries-cartographic.zip",
        "members": {
            "population": "1",
            "low_income_all_denominator": "847",
            "low_income_all_numerator": "852",
            "low_income_all_percent_source": "857",
            "low_income_denominator": "850",
            "low_income_numerator": "855",
            "lico_all_denominator": "847",
            "lico_all_numerator": "862",
            "lico_all_percent_source": "867",
            "low_education_denominator": "1698",
            "low_education_numerator": "1699",
            "low_education_15plus_denominator": "1683",
            "low_education_15plus_numerator": "1684",
            "language_denominator": "100",
            "language_numerator": "104",
            "housing_burden_denominator": "1667",
            "housing_burden_numerator": "1669",
            "owner_housing_burden_denominator": "1671",
            "owner_housing_burden_percent_source": "1673",
            "renter_housing_burden_denominator": "1678",
            "renter_housing_burden_percent_source": "1680",
            "labour_force_denominator": "1866",
            "unemployment_numerator": "1868",
        },
    },
    "2021": {
        "dataset": "CA21",
        "census_year": 2021,
        "source_label": "2021 Census Profile, Statistics Canada regional CSV download",
        "download_url": "https://www12.statcan.gc.ca/census-recensement/2021/dp-pd/prof/details/download-telecharger/comp/GetFile.cfm?Lang=E&FILETYPE=CSV&GEONO=006_BC_CB",
        "boundary_url": "https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lda_000b21a_e.zip",
        "zip_name": "statcan-2021-bc-profile-da.zip",
        "boundary_zip_name": "statcan-2021-da-boundaries-cartographic.zip",
        "members": {
            "population": "1",
            "low_income_all_denominator": "335",
            "low_income_all_numerator": "340",
            "low_income_all_percent_source": "345",
            "low_income_denominator": "338",
            "low_income_numerator": "343",
            "lico_all_denominator": "350",
            "lico_all_numerator": "355",
            "lico_all_percent_source": "360",
            "low_education_denominator": "2014",
            "low_education_numerator": "2015",
            "low_education_15plus_denominator": "1998",
            "low_education_15plus_numerator": "1999",
            "language_denominator": "383",
            "language_numerator": "387",
            "housing_burden_denominator": "1465",
            "housing_burden_numerator": "1467",
            "owner_housing_burden_denominator": "1482",
            "owner_housing_burden_percent_source": "1484",
            "renter_housing_burden_denominator": "1490",
            "renter_housing_burden_percent_source": "1492",
            "labour_force_denominator": "2224",
            "unemployment_numerator": "2226",
        },
    },
}


INDICATORS = [
    ("low_income", "low_income_numerator", "low_income_denominator", "low_income_percent"),
    ("low_education", "low_education_numerator", "low_education_denominator", "low_education_percent"),
    ("linguistic_isolation", "language_numerator", "language_denominator", "linguistic_isolation_percent"),
    ("housing_burden", "housing_burden_numerator", "housing_burden_denominator", "housing_burden_percent"),
    ("unemployment", "unemployment_numerator", "labour_force_denominator", "unemployment_percent"),
]


def parse_args(argv):
    args = {"years": "2016,2021", "overwrite": "false", "delay": "0.25"}
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


def download_file(url, output_path, overwrite=False):
    if output_path.exists() and not overwrite:
        return output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=60) as response:
        response.raise_for_status()
        tmp_path = output_path.with_suffix(output_path.suffix + ".tmp")
        with tmp_path.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    handle.write(chunk)
        tmp_path.replace(output_path)
    return output_path


def total_column(fieldnames):
    for name in fieldnames:
        normalized = name.lower()
        if normalized == "c1_count_total":
            return name
        if "total - sex" in normalized or normalized.endswith("[1]: total"):
            return name
    raise ValueError("Could not find total-sex value column")


def read_statcan_da_records(zip_path, config):
    cache_path = RAW_DIR / f"{config['dataset']}_bc_da_selected_records.json"
    cache_meta_path = RAW_DIR / f"{config['dataset']}_bc_da_selected_records.manifest.json"
    expected_fields = sorted(config["members"].keys())
    if cache_path.exists() and cache_meta_path.exists():
        cache_meta = json.loads(cache_meta_path.read_text())
        if cache_meta.get("fields") == expected_fields:
            records = json.loads(cache_path.read_text())
            return records, cache_meta.get("characteristics", {}), cache_meta.get("matchedCharacteristicRows", 0)

    target_members = set(config["members"].values())
    member_to_field = {member: field for field, member in config["members"].items()}
    records = defaultdict(dict)
    characteristics = {}
    row_count = 0

    with zipfile.ZipFile(zip_path) as archive:
        csv_name = next(name for name in archive.namelist() if name.lower().endswith(".csv") and "_data" in name.lower())
        with archive.open(csv_name) as raw:
            text = (line.decode("utf-8-sig", errors="replace") for line in raw)
            reader = csv.DictReader(text)
            value_column = total_column(reader.fieldnames or [])
            member_column = "CHARACTERISTIC_ID" if "CHARACTERISTIC_ID" in (reader.fieldnames or []) else next(name for name in reader.fieldnames or [] if name.startswith("Member ID:"))
            characteristic_column = "CHARACTERISTIC_NAME" if "CHARACTERISTIC_NAME" in (reader.fieldnames or []) else next(name for name in reader.fieldnames or [] if name.startswith("DIM:") or name.startswith("Dim:"))

            for row in reader:
                geo_code = (row.get("GEO_CODE (POR)") or row.get("ALT_GEO_CODE") or "").strip()
                if not re.match(r"^59\d{6}$", geo_code):
                    continue
                member = (row.get(member_column) or "").strip()
                if member not in target_members:
                    continue
                field = member_to_field[member]
                records[geo_code][field] = parse_number(row.get(value_column))
                records[geo_code]["geo_uid"] = geo_code
                records[geo_code]["geo_name"] = row.get("GEO_NAME", "")
                records[geo_code]["data_quality_flag"] = row.get("DATA_QUALITY_FLAG", "")
                characteristics[field] = {
                    "member_id": member,
                    "label": row.get(characteristic_column, ""),
                }
                row_count += 1

    output_records = list(records.values())
    cache_path.write_text(json.dumps(output_records, separators=(",", ":")) + "\n")
    cache_meta_path.write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "dataset": config["dataset"],
                "sourceZip": str(zip_path.relative_to(OUTPUT_DIR)),
                "fields": expected_fields,
                "characteristics": characteristics,
                "records": len(output_records),
                "matchedCharacteristicRows": row_count,
            },
            indent=2,
        )
        + "\n"
    )
    return output_records, characteristics, row_count


def parse_number(value):
    if value is None:
        return None
    cleaned = str(value).strip().replace(",", "")
    if not cleaned or cleaned in {"...", "x", "F"}:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def extract_zip(zip_path, output_dir, overwrite=False):
    marker = output_dir / ".extracted"
    if marker.exists() and not overwrite:
        return output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(output_dir)
    marker.write_text(datetime.now(timezone.utc).isoformat())
    return output_dir


def download_da_boundary_zip(config, overwrite=False):
    return download_file(config["boundary_url"], RAW_DIR / config["boundary_zip_name"], overwrite=overwrite)


def find_shapefile(directory):
    matches = sorted(directory.rglob("*.shp"))
    if not matches:
        raise FileNotFoundError(f"No .shp found under {directory}")
    return matches[0]


def load_lha_features():
    data = json.loads(LHA_BOUNDARIES.read_text())
    entries = []
    for feature in data["features"]:
        props = feature["properties"]
        geom = shape(feature["geometry"])
        entries.append(
            {
                "feature": feature,
                "geometry": geom,
                "prepared": prep(geom),
                "bounds": geom.bounds,
                "info": {
                    "lha_code": str(props.get("LOCAL_HLTH_AREA_CODE", "")).zfill(3),
                    "lha_name": props.get("LOCAL_HLTH_AREA_NAME", ""),
                    "hsda_code": props.get("HLTH_SERVICE_DLVR_AREA_CODE", ""),
                    "hsda_name": props.get("HLTH_SERVICE_DLVR_AREA_NAME", ""),
                    "ha_code": props.get("HLTH_AUTHORITY_CODE", ""),
                    "ha_name": props.get("HLTH_AUTHORITY_NAME", ""),
                },
            }
        )
    return entries


def assign_da_to_lha(boundary_zip_path, config, lha_entries, overwrite=False):
    extract_dir = RAW_DIR / f"{config['dataset']}_da_boundaries"
    extract_zip(boundary_zip_path, extract_dir, overwrite=overwrite)
    shp_path = find_shapefile(extract_dir)
    reader = shapefile.Reader(str(shp_path), encoding="latin1")
    fields = [field[0] for field in reader.fields[1:]]
    assignments = []
    missing = []
    for shape_record in reader.iterShapeRecords():
        props = dict(zip(fields, shape_record.record))
        geo_uid = str(props.get("DAUID") or props.get("dauid") or props.get("DAUIDU") or "").strip()
        if not re.match(r"^59\d{6}$", geo_uid):
            continue
        if not geo_uid:
            continue
        source_point = shape(shape_record.shape.__geo_interface__).representative_point()
        lon, lat = LAMBERT_TO_WGS84.transform(source_point.x, source_point.y)
        point = shape({"type": "Point", "coordinates": (lon, lat)})
        x, y = point.x, point.y
        match = None
        for entry in lha_entries:
            minx, miny, maxx, maxy = entry["bounds"]
            if x < minx or x > maxx or y < miny or y > maxy:
                continue
            if entry["prepared"].contains(point) or entry["prepared"].covers(point):
                match = entry["info"]
                break
        if match:
            assignments.append({"geo_uid": geo_uid, **match})
        else:
            missing.append(geo_uid)
    return assignments, missing, str(shp_path.relative_to(OUTPUT_DIR))


def aggregate(records, assignments, lha_entries, config):
    records_by_geo = {record["geo_uid"]: record for record in records}
    lha_rows = {
        entry["info"]["lha_code"]: {
            **entry["info"],
            "census_year": config["census_year"],
            "dataset": config["dataset"],
            "da_count": 0,
            "population_sum": 0,
        }
        for entry in lha_entries
    }

    for assignment in assignments:
        record = records_by_geo.get(assignment["geo_uid"])
        if not record:
            continue
        row = lha_rows.get(assignment["lha_code"])
        if not row:
            continue
        row["da_count"] += 1
        row["population_sum"] += record.get("population") or 0
        for indicator_id, numerator_field, denominator_field, _percent_field in INDICATORS:
            row[f"{indicator_id}_numerator"] = row.get(f"{indicator_id}_numerator", 0) + (record.get(numerator_field) or 0)
            row[f"{indicator_id}_denominator"] = row.get(f"{indicator_id}_denominator", 0) + (record.get(denominator_field) or 0)
        if "employment_insurance_numerator" in config["members"]:
            row["employment_insurance_numerator"] = row.get("employment_insurance_numerator", 0) + (record.get("employment_insurance_numerator") or 0)
            row["employment_insurance_denominator"] = row.get("employment_insurance_denominator", 0) + (record.get("employment_insurance_denominator") or 0)
        row["low_education_15plus_numerator"] = row.get("low_education_15plus_numerator", 0) + (record.get("low_education_15plus_numerator") or 0)
        row["low_education_15plus_denominator"] = row.get("low_education_15plus_denominator", 0) + (record.get("low_education_15plus_denominator") or 0)
        for prefix in ["low_income_all", "lico_all"]:
            row[f"{prefix}_numerator"] = row.get(f"{prefix}_numerator", 0) + (record.get(f"{prefix}_numerator") or 0)
            row[f"{prefix}_denominator"] = row.get(f"{prefix}_denominator", 0) + (record.get(f"{prefix}_denominator") or 0)
            percent = record.get(f"{prefix}_percent_source")
            if percent is not None:
                row[f"{prefix}_da_percent_sum"] = row.get(f"{prefix}_da_percent_sum", 0) + percent
                row[f"{prefix}_da_percent_count"] = row.get(f"{prefix}_da_percent_count", 0) + 1
        renter_denominator = record.get("renter_housing_burden_denominator") or 0
        row["renter_housing_burden_total_denominator"] = row.get("renter_housing_burden_total_denominator", 0) + renter_denominator
        renter_percent = record.get("renter_housing_burden_percent_source")
        if renter_denominator and renter_percent is not None:
            row["renter_housing_burden_numerator"] = row.get("renter_housing_burden_numerator", 0) + (renter_denominator * renter_percent / 100)
            row["renter_housing_burden_denominator"] = row.get("renter_housing_burden_denominator", 0) + renter_denominator
            row["renter_housing_burden_da_percent_sum"] = row.get("renter_housing_burden_da_percent_sum", 0) + renter_percent
            row["renter_housing_burden_da_percent_count"] = row.get("renter_housing_burden_da_percent_count", 0) + 1
            for threshold in [20, 30, 50, 100]:
                if renter_denominator >= threshold:
                    prefix = f"renter_housing_burden_ge{threshold}"
                    row[f"{prefix}_numerator"] = row.get(f"{prefix}_numerator", 0) + (renter_denominator * renter_percent / 100)
                    row[f"{prefix}_denominator"] = row.get(f"{prefix}_denominator", 0) + renter_denominator
        owner_denominator = record.get("owner_housing_burden_denominator") or 0
        owner_percent = record.get("owner_housing_burden_percent_source")
        if owner_denominator and owner_percent is not None:
            row["owner_housing_burden_numerator"] = row.get("owner_housing_burden_numerator", 0) + (owner_denominator * owner_percent / 100)
            row["owner_housing_burden_denominator"] = row.get("owner_housing_burden_denominator", 0) + owner_denominator
            row["owner_housing_burden_da_percent_sum"] = row.get("owner_housing_burden_da_percent_sum", 0) + owner_percent
            row["owner_housing_burden_da_percent_count"] = row.get("owner_housing_burden_da_percent_count", 0) + 1

    for row in lha_rows.values():
        for indicator_id, _numerator_field, _denominator_field, percent_field in INDICATORS:
            numerator = row.get(f"{indicator_id}_numerator", 0)
            denominator = row.get(f"{indicator_id}_denominator", 0)
            row[percent_field] = round(numerator / denominator * 100, 3) if denominator else None
        row["low_education_15plus_percent"] = (
            round(row["low_education_15plus_numerator"] / row["low_education_15plus_denominator"] * 100, 3)
            if row.get("low_education_15plus_denominator")
            else None
        )
        for prefix in ["low_income_all", "lico_all"]:
            row[f"{prefix}_percent"] = (
                round(row[f"{prefix}_numerator"] / row[f"{prefix}_denominator"] * 100, 3)
                if row.get(f"{prefix}_denominator")
                else None
            )
            row[f"{prefix}_da_percent_unweighted"] = (
                round(row[f"{prefix}_da_percent_sum"] / row[f"{prefix}_da_percent_count"], 3)
                if row.get(f"{prefix}_da_percent_count")
                else None
            )
        row["renter_housing_burden_percent"] = (
            round(row["renter_housing_burden_numerator"] / row["renter_housing_burden_denominator"] * 100, 3)
            if row.get("renter_housing_burden_denominator")
            else None
        )
        total_renter_denominator = row.get("renter_housing_burden_total_denominator", 0)
        reported_renter_denominator = row.get("renter_housing_burden_denominator", 0)
        row["renter_housing_burden_reported_coverage"] = (
            round(reported_renter_denominator / total_renter_denominator, 6) if total_renter_denominator else None
        )
        row["renter_housing_burden_da_percent_unweighted"] = (
            round(row["renter_housing_burden_da_percent_sum"] / row["renter_housing_burden_da_percent_count"], 3)
            if row.get("renter_housing_burden_da_percent_count")
            else None
        )
        for threshold in [20, 30, 50, 100]:
            prefix = f"renter_housing_burden_ge{threshold}"
            row[f"{prefix}_percent"] = (
                round(row[f"{prefix}_numerator"] / row[f"{prefix}_denominator"] * 100, 3)
                if row.get(f"{prefix}_denominator")
                else None
            )
            retained_denominator = row.get(f"{prefix}_denominator", 0)
            coverage = retained_denominator / total_renter_denominator if total_renter_denominator else None
            row[f"{prefix}_coverage"] = round(coverage, 6) if coverage is not None else None
            for minimum_coverage in [0.5, 0.75, 0.9]:
                coverage_key = int(minimum_coverage * 100)
                row[f"{prefix}_min_coverage_{coverage_key}_percent"] = (
                    row[f"{prefix}_percent"] if coverage is not None and coverage >= minimum_coverage else None
                )
        row["owner_housing_burden_percent"] = (
            round(row["owner_housing_burden_numerator"] / row["owner_housing_burden_denominator"] * 100, 3)
            if row.get("owner_housing_burden_denominator")
            else None
        )
        row["owner_housing_burden_da_percent_unweighted"] = (
            round(row["owner_housing_burden_da_percent_sum"] / row["owner_housing_burden_da_percent_count"], 3)
            if row.get("owner_housing_burden_da_percent_count")
            else None
        )
        if row.get("owner_housing_burden_numerator") is not None and row.get("renter_housing_burden_numerator") is not None:
            combined_numerator = row.get("owner_housing_burden_numerator", 0) + row.get("renter_housing_burden_numerator", 0)
            combined_denominator = row.get("owner_housing_burden_denominator", 0) + row.get("renter_housing_burden_denominator", 0)
            row["owner_renter_housing_burden_percent_from_split"] = (
                round(combined_numerator / combined_denominator * 100, 3) if combined_denominator else None
            )
            if row.get("owner_housing_burden_percent") is not None and row.get("renter_housing_burden_percent") is not None:
                row["owner_plus_renter_housing_burden_percent"] = round(
                    row["owner_housing_burden_percent"] + row["renter_housing_burden_percent"],
                    3,
                )
                row["owner_renter_housing_burden_percent_mean"] = round(
                    (row["owner_housing_burden_percent"] + row["renter_housing_burden_percent"]) / 2,
                    3,
                )
        if row.get("employment_insurance_denominator"):
            row["employment_insurance_percent"] = round(row["employment_insurance_numerator"] / row["employment_insurance_denominator"] * 100, 3)
    return [lha_rows[key] for key in sorted(lha_rows)]


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


def sync_dataset(year, config, lha_entries, api_key, overwrite=False, delay=0.25):
    print(f"Census BCEnviroScreen StatCan: {year}", flush=True)
    zip_path = download_file(config["download_url"], RAW_DIR / config["zip_name"], overwrite=overwrite)
    records, characteristics, matched_rows = read_statcan_da_records(zip_path, config)
    boundary_zip_path = download_da_boundary_zip(config, overwrite=overwrite)
    assignments, missing, boundary_shapefile = assign_da_to_lha(boundary_zip_path, config, lha_entries, overwrite=overwrite)
    lha_rows = aggregate(records, assignments, lha_entries, config)

    dataset_dir = OUTPUT_DIR / year
    dataset_dir.mkdir(parents=True, exist_ok=True)
    write_csv(dataset_dir / "da-to-lha-crosswalk.csv", assignments)
    write_csv(dataset_dir / "lha-socioeconomic.csv", lha_rows)
    (dataset_dir / "da-to-lha-crosswalk.json").write_text(json.dumps({"dataset": config["dataset"], "censusYear": config["census_year"], "assignments": assignments, "missing": missing}, indent=2) + "\n")
    (dataset_dir / "lha-socioeconomic.json").write_text(json.dumps(lha_rows, indent=2) + "\n")

    return {
        "dataset": config["dataset"],
        "censusYear": config["census_year"],
        "sourceLabel": config["source_label"],
        "sourceUrl": config["download_url"],
        "boundaryUrl": config["boundary_url"],
        "rawZip": str(zip_path.relative_to(OUTPUT_DIR)),
        "rawBoundaryZip": str(boundary_zip_path.relative_to(OUTPUT_DIR)),
        "rawBoundaryShapefile": boundary_shapefile,
        "daRows": len(records),
        "matchedCharacteristicRows": matched_rows,
        "assignedDaFeatures": len(assignments),
        "missingDaFeatures": len(missing),
        "lhaRows": len(lha_rows),
        "characteristics": characteristics,
        "outputs": {
            "crosswalkCsv": f"{year}/da-to-lha-crosswalk.csv",
            "crosswalkJson": f"{year}/da-to-lha-crosswalk.json",
            "lhaSocioeconomicCsv": f"{year}/lha-socioeconomic.csv",
            "lhaSocioeconomicJson": f"{year}/lha-socioeconomic.json",
        },
    }


def main():
    args = parse_args(sys.argv[1:])
    years = [year.strip() for year in args["years"].split(",") if year.strip()]
    overwrite = args.get("overwrite") == "true"
    delay = float(args.get("delay", "0.25"))
    api_key = os.environ.get("CM_API_KEY") or args.get("api-key") or DEFAULT_API_KEY

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    lha_entries = load_lha_features()

    summaries = []
    for year in years:
        if year not in DATASETS:
            raise ValueError(f"Unsupported year {year}; supported years: {', '.join(DATASETS)}")
        summaries.append(sync_dataset(year, DATASETS[year], lha_entries, api_key, overwrite=overwrite, delay=delay))

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "Statistics Canada Census Profile regional CSV downloads; CensusMapper DA geometry chunks",
        "note": "DA-to-LHA assignment uses each DA geometry representative point against current BC Ministry of Health LHA boundaries.",
        "geography": {
            "province": "British Columbia",
            "lhaBoundarySource": str(LHA_BOUNDARIES.relative_to(PGMAPS_ROOT)),
            "lhaCount": len(lha_entries),
        },
        "summaries": summaries,
    }
    (OUTPUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Census BCEnviroScreen: wrote {OUTPUT_DIR.relative_to(PGMAPS_ROOT)}", flush=True)


if __name__ == "__main__":
    main()
