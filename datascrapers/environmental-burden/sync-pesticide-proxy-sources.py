#!/usr/bin/env python3

import argparse
import csv
import json
import math
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_OUTPUT_DIR = Path("tmp/calenviroscreen/pesticide-proxy")
PAGE_SIZE = 1000
PG_BBOX = (-122.89936984, 53.8126077, -122.60433309, 54.04174962)

IAPP_CHEMICAL_TREATMENT_LAYER = {
    "id": "bc_iapp_chemical_treatment_area",
    "title": "BC Invasive Alien Plant Chemical Treatment Area",
    "catalog_url": "https://catalogue.data.gov.bc.ca/dataset/invasive-alien-plant-chemical-treatment-area",
    "url": "https://delivery.maps.gov.bc.ca/arcgis/rest/services/whse/bcgw_pub_whse_forest_vegetation/MapServer/46",
    "where": "1=1",
    "out_fields": (
        "OBJECTID,TREATMENT_ID,SITE_ID,INVASIVE_PLANT,TREATMENT_DATE,AREA_TREATED,"
        "HERBICIDE_CODE,HERBICIDE,CHEMICAL_METHOD,FEATURE_AREA_SQM,FEATURE_LENGTH_M,APP_LINK"
    ),
}

RESULTS_CHEMICAL_BRUSHING_LAYER = {
    "id": "bc_results_chemical_brushing_treatment_units",
    "title": "BC RESULTS Activity Treatment Units - Chemical Brushing",
    "catalog_url": "https://catalogue.data.gov.bc.ca/dataset/results-activity-treatment-units",
    "url": "https://delivery.maps.gov.bc.ca/arcgis/rest/services/whse/bcgw_pub_whse_forest_vegetation/MapServer/8",
    "where": "SILV_BASE_CODE='BR' AND SILV_TECHNIQUE_CODE IN ('CA','CG')",
    "out_fields": (
        "OBJECTID,ACTIVITY_TREATMENT_UNIT_ID,OPENING_ID,MAP_LABEL,SILV_BASE_CODE,"
        "SILV_TECHNIQUE_CODE,SILV_METHOD_CODE,ATU_START_DATE,ATU_COMPLETION_DATE,"
        "ACTUAL_TREATMENT_AREA,PLANNED_DATE,PLANNED_TREATMENT_AREA,DISTURBANCE_CODE"
    ),
}


def request_json(url, params, timeout=120):
    full_url = f"{url}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(full_url, headers={"User-Agent": "PGMaps pesticide proxy rebuild"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def layer_metadata(layer):
    data = request_json(layer["url"], {"f": "json"})
    if "error" in data:
        raise RuntimeError(f"Metadata failed for {layer['id']}: {data['error']}")
    return data


def layer_count(layer, bbox=None):
    params = {"where": layer["where"], "returnCountOnly": "true", "f": "json"}
    if bbox:
        params.update(
            {
                "geometry": ",".join(str(x) for x in bbox),
                "geometryType": "esriGeometryEnvelope",
                "inSR": "4326",
                "spatialRel": "esriSpatialRelIntersects",
            }
        )
    data = request_json(f"{layer['url']}/query", params)
    if "error" in data:
        raise RuntimeError(f"Count failed for {layer['id']}: {data['error']}")
    return int(data["count"])


def download_layer(layer, output_path, bbox=None):
    metadata = layer_metadata(layer)
    page_size = min(PAGE_SIZE, int(metadata.get("maxRecordCount") or PAGE_SIZE))
    count = layer_count(layer, bbox=bbox)
    pages = math.ceil(count / page_size) if count else 0
    features = []

    for page_index in range(pages):
        offset = page_index * page_size
        params = {
            "where": layer["where"],
            "outFields": layer["out_fields"],
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "geojson",
            "resultOffset": offset,
            "resultRecordCount": page_size,
            "orderByFields": "OBJECTID ASC",
        }
        if bbox:
            params.update(
                {
                    "geometry": ",".join(str(x) for x in bbox),
                    "geometryType": "esriGeometryEnvelope",
                    "inSR": "4326",
                    "spatialRel": "esriSpatialRelIntersects",
                }
            )
        data = request_json(f"{layer['url']}/query", params)
        if "error" in data:
            raise RuntimeError(f"Download failed for {layer['id']} offset {offset}: {data['error']}")
        page_features = data.get("features", [])
        features.extend(page_features)
        print(f"{layer['id']}: {page_index + 1}/{pages} pages, {len(page_features)} features")
        time.sleep(0.1)

    feature_collection = {
        "type": "FeatureCollection",
        "name": layer["id"],
        "features": features,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(feature_collection, separators=(",", ":")) + "\n")
    return {
        "featureCount": count,
        "downloadedFeatureCount": len(features),
        "pageSize": page_size,
        "pageCount": pages,
        "metadata": {
            "name": metadata.get("name"),
            "type": metadata.get("type"),
            "geometryType": metadata.get("geometryType"),
            "maxRecordCount": metadata.get("maxRecordCount"),
            "fields": [
                {"name": field.get("name"), "alias": field.get("alias"), "type": field.get("type")}
                for field in metadata.get("fields", [])
            ],
        },
    }


def arcgis_date_to_year(value):
    if value in (None, ""):
        return ""
    try:
        return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc).year
    except Exception:
        return ""


def numeric_area(value):
    if value in (None, ""):
        return 0.0
    try:
        return float(value)
    except Exception:
        return 0.0


def summarize_treatments(geojson_path, summary_csv_path):
    data = json.loads(geojson_path.read_text())
    by_year = Counter()
    by_herbicide = Counter()
    by_method = Counter()
    herbicide_area = defaultdict(float)
    rows = []

    for feature in data.get("features", []):
        props = feature.get("properties", {})
        year = arcgis_date_to_year(props.get("TREATMENT_DATE"))
        herbicide = (props.get("HERBICIDE") or "Unknown").strip() or "Unknown"
        method = (props.get("CHEMICAL_METHOD") or "Unknown").strip() or "Unknown"
        area_sqm = numeric_area(props.get("FEATURE_AREA_SQM"))
        by_year[year] += 1
        by_herbicide[herbicide] += 1
        by_method[method] += 1
        herbicide_area[herbicide] += area_sqm
        rows.append(
            {
                "objectid": props.get("OBJECTID"),
                "treatment_id": props.get("TREATMENT_ID"),
                "site_id": props.get("SITE_ID"),
                "year": year,
                "invasive_plant": props.get("INVASIVE_PLANT"),
                "herbicide": herbicide,
                "chemical_method": method,
                "area_treated": props.get("AREA_TREATED"),
                "feature_area_sqm": area_sqm,
                "app_link": props.get("APP_LINK"),
            }
        )

    summary_csv_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "objectid",
        "treatment_id",
        "site_id",
        "year",
        "invasive_plant",
        "herbicide",
        "chemical_method",
        "area_treated",
        "feature_area_sqm",
        "app_link",
    ]
    with summary_csv_path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    return {
        "featureCount": len(rows),
        "yearCounts": dict(sorted(by_year.items(), key=lambda item: str(item[0]))),
        "herbicideCounts": dict(by_herbicide.most_common()),
        "methodCounts": dict(by_method.most_common()),
        "herbicideAreaSqm": dict(sorted(herbicide_area.items())),
    }


def summarize_results_brushing(geojson_path, summary_csv_path):
    data = json.loads(geojson_path.read_text())
    by_year = Counter()
    by_technique = Counter()
    by_method = Counter()
    technique_area = defaultdict(float)
    rows = []

    for feature in data.get("features", []):
        props = feature.get("properties", {})
        year = arcgis_date_to_year(props.get("ATU_COMPLETION_DATE") or props.get("ATU_START_DATE"))
        technique = (props.get("SILV_TECHNIQUE_CODE") or "Unknown").strip() or "Unknown"
        method = (props.get("SILV_METHOD_CODE") or "Unknown").strip() or "Unknown"
        actual_area = numeric_area(props.get("ACTUAL_TREATMENT_AREA"))
        by_year[year] += 1
        by_technique[technique] += 1
        by_method[method] += 1
        technique_area[technique] += actual_area
        rows.append(
            {
                "objectid": props.get("OBJECTID"),
                "activity_treatment_unit_id": props.get("ACTIVITY_TREATMENT_UNIT_ID"),
                "opening_id": props.get("OPENING_ID"),
                "map_label": props.get("MAP_LABEL"),
                "year": year,
                "silv_base_code": props.get("SILV_BASE_CODE"),
                "silv_technique_code": technique,
                "silv_method_code": method,
                "atu_start_date": props.get("ATU_START_DATE"),
                "atu_completion_date": props.get("ATU_COMPLETION_DATE"),
                "actual_treatment_area": actual_area,
                "planned_treatment_area": props.get("PLANNED_TREATMENT_AREA"),
                "disturbance_code": props.get("DISTURBANCE_CODE"),
            }
        )

    summary_csv_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "objectid",
        "activity_treatment_unit_id",
        "opening_id",
        "map_label",
        "year",
        "silv_base_code",
        "silv_technique_code",
        "silv_method_code",
        "atu_start_date",
        "atu_completion_date",
        "actual_treatment_area",
        "planned_treatment_area",
        "disturbance_code",
    ]
    with summary_csv_path.open("w", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    return {
        "featureCount": len(rows),
        "yearCounts": dict(sorted(by_year.items(), key=lambda item: str(item[0]))),
        "techniqueCounts": dict(by_technique.most_common()),
        "methodCounts": dict(by_method.most_common()),
        "techniqueArea": dict(sorted(technique_area.items())),
    }


def parse_args():
    parser = argparse.ArgumentParser(description="Download pesticide-use proxy sources for PGMaps.")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--bc-wide", action="store_true", help="Also download the full BC treatment layer.")
    parser.add_argument(
        "--bbox",
        default=",".join(str(x) for x in PG_BBOX),
        help="xmin,ymin,xmax,ymax bbox for the local extract. Defaults to the Prince George municipal bbox.",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    output_dir = Path(args.output_dir)
    bbox = tuple(float(x) for x in args.bbox.split(","))
    if len(bbox) != 4:
        raise ValueError("--bbox must be xmin,ymin,xmax,ymax")

    output_dir.mkdir(parents=True, exist_ok=True)
    local_geojson = output_dir / "iapp-chemical-treatment-pg-bbox.geojson"
    local_csv = output_dir / "iapp-chemical-treatment-pg-bbox.csv"
    local_results_geojson = output_dir / "results-chemical-brushing-pg-bbox.geojson"
    local_results_csv = output_dir / "results-chemical-brushing-pg-bbox.csv"

    local_download = download_layer(IAPP_CHEMICAL_TREATMENT_LAYER, local_geojson, bbox=bbox)
    local_summary = summarize_treatments(local_geojson, local_csv)
    local_results_download = download_layer(RESULTS_CHEMICAL_BRUSHING_LAYER, local_results_geojson, bbox=bbox)
    local_results_summary = summarize_results_brushing(local_results_geojson, local_results_csv)

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sources": [IAPP_CHEMICAL_TREATMENT_LAYER, RESULTS_CHEMICAL_BRUSHING_LAYER],
        "localBbox": bbox,
        "outputs": {
            "localGeojson": str(local_geojson),
            "localCsv": str(local_csv),
            "localResultsChemicalBrushingGeojson": str(local_results_geojson),
            "localResultsChemicalBrushingCsv": str(local_results_csv),
        },
        "localDownload": local_download,
        "localSummary": local_summary,
        "localResultsChemicalBrushingDownload": local_results_download,
        "localResultsChemicalBrushingSummary": local_results_summary,
        "notes": [
            "This is a pesticide-use proxy, not a complete pesticide application database.",
            "The IAPP layer captures invasive-plant chemical treatments with herbicide/method/date/area fields.",
            "The RESULTS chemical brushing layer captures forestry treatment units coded as chemical aerial or chemical ground brushing, but not product names.",
            "It does not capture all agricultural, forestry, railway, utility, municipal, or private pesticide applications.",
        ],
    }

    if args.bc_wide:
        bc_geojson = output_dir / "iapp-chemical-treatment-bc.geojson"
        bc_csv = output_dir / "iapp-chemical-treatment-bc.csv"
        bc_results_geojson = output_dir / "results-chemical-brushing-bc.geojson"
        bc_results_csv = output_dir / "results-chemical-brushing-bc.csv"
        bc_download = download_layer(IAPP_CHEMICAL_TREATMENT_LAYER, bc_geojson)
        bc_summary = summarize_treatments(bc_geojson, bc_csv)
        bc_results_download = download_layer(RESULTS_CHEMICAL_BRUSHING_LAYER, bc_results_geojson)
        bc_results_summary = summarize_results_brushing(bc_results_geojson, bc_results_csv)
        manifest["outputs"]["bcGeojson"] = str(bc_geojson)
        manifest["outputs"]["bcCsv"] = str(bc_csv)
        manifest["outputs"]["bcResultsChemicalBrushingGeojson"] = str(bc_results_geojson)
        manifest["outputs"]["bcResultsChemicalBrushingCsv"] = str(bc_results_csv)
        manifest["bcDownload"] = bc_download
        manifest["bcSummary"] = bc_summary
        manifest["bcResultsChemicalBrushingDownload"] = bc_results_download
        manifest["bcResultsChemicalBrushingSummary"] = bc_results_summary

    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2)[:6000])


if __name__ == "__main__":
    main()
