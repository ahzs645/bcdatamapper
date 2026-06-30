#!/usr/bin/env python3

import json
import math
import time
import urllib.parse
import urllib.request
import argparse
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "raw-rebuild-seed" / "large" / "linear-footprint"
PAGE_SIZE = 2000
OUT_SR = 3005


LAYERS = [
    {
        "id": "bcer_geophysical_lines_2020_no_handcut_aero",
        "name": "BCER Geophysical Lines, active through 2020, excluding handcut/aeromagnetic",
        "url": "https://geoweb-ags.bc-er.ca/arcgis/rest/services/PASR/PASR_GEOPHYSICAL_LN/MapServer/0",
        "where": (
            "ACTIVITY_APPROVAL_DATE <= timestamp '2020-12-31 23:59:59' "
            "AND (ACTIVITY_CANCEL_DATE IS NULL OR ACTIVITY_CANCEL_DATE > timestamp '2020-12-31 23:59:59') "
            "AND (CUT_TYPE_DESC IS NULL OR (UPPER(CUT_TYPE_DESC) NOT LIKE '%HAND%' "
            "AND UPPER(CUT_TYPE_DESC) NOT LIKE '%AERO%'))"
        ),
        "out_fields": (
            "OBJECTID,GEO_NUMBER,PROGRAM_TYPE,STAGE,STAGE_DESCRIPTION,LINE_TYPE,CUT_TYPE,"
            "CUT_TYPE_DESC,LINE_WIDTH,STATUS,ACTIVITY_APPROVAL_DATE,ACTIVITY_CANCEL_DATE,DATA_SOURCE"
        ),
    },
    {
        "id": "bcer_geophysical_final_plans_1996_2004_no_handcut_aero",
        "name": "BCER Geophysical Final Plans 1996-2004, excluding handcut/aeromagnetic",
        "url": "https://geoweb-ags.bc-er.ca/arcgis/rest/services/REFERENCE/GEO_FINAL_PLAN_1996_2004_LN/FeatureServer/0",
        "where": (
            "(CUT_TYPE IS NULL OR (UPPER(CUT_TYPE) NOT LIKE '%HAND%' AND UPPER(CUT_TYPE) NOT LIKE '%AERO%')) "
            "AND (METHOD IS NULL OR (UPPER(METHOD) NOT LIKE '%HAND%' AND UPPER(METHOD) NOT LIKE '%AERO%'))"
        ),
        "out_fields": (
            "OBJECTID,FILE_NUM,GEO_NUM,APPL_RECD,PROG_TYPE,CLEARING,METHOD,LINE_NAME,"
            "LINE_TYPE,CUT_TYPE,WIDTH,LAND_TYPE,COMP_DATE"
        ),
    },
    {
        "id": "bcer_pipeline_segments_2020",
        "name": "BCER Pipeline Segments, active through 2020",
        "url": "https://geoweb-ags.bc-er.ca/arcgis/rest/services/PASR/PASR_PL_SEGMENT_LN/MapServer/0",
        "where": (
            "ACTIVITY_APPROVAL_DATE <= timestamp '2020-12-31 23:59:59' "
            "AND (ACTIVITY_CANCEL_DATE IS NULL OR ACTIVITY_CANCEL_DATE > timestamp '2020-12-31 23:59:59')"
        ),
        "out_fields": (
            "OBJECTID,PROJECT_NUMBER,SEGMENT_NUMBER,LINE_TYPE,LINE_TYPE_DESC,PHYSICAL_PIPE_LENGTH,"
            "STATUS,ACTIVITY_APPROVAL_DATE,ACTIVITY_CANCEL_DATE,AUTHORITY_TYPE,DATA_SOURCE"
        ),
    },
    {
        "id": "bcgw_forest_tenure_road_sections",
        "name": "BC Geographic Warehouse Forest Tenure Road Section Lines",
        "url": "https://delivery.maps.gov.bc.ca/arcgis/rest/services/mpcm/bcgwpub/MapServer/196",
        "where": "1=1",
        "out_fields": "OBJECTID",
    },
    {
        "id": "bcgw_railway_track",
        "name": "BC Geographic Warehouse Railway Track",
        "url": "https://delivery.maps.gov.bc.ca/arcgis/rest/services/mpcm/bcgwpub/MapServer/257",
        "where": "1=1",
        "out_fields": "OBJECTID",
    },
    {
        "id": "bcgw_transmission_lines",
        "name": "BC Geographic Warehouse BC Transmission Lines",
        "url": "https://delivery.maps.gov.bc.ca/arcgis/rest/services/mpcm/bcgwpub/MapServer/130",
        "where": "1=1",
        "out_fields": "OBJECTID",
    },
    {
        "id": "bcgw_digital_road_atlas_mpar",
        "name": "BC Geographic Warehouse Digital Road Atlas Master Partially Attributed Roads",
        "url": "https://delivery.maps.gov.bc.ca/arcgis/rest/services/mpcm/bcgwpub/MapServer/464",
        "where": "1=1",
        "out_fields": "OBJECTID",
    },
]

DEFAULT_LAYER_IDS = {
    "bcer_geophysical_lines_2020_no_handcut_aero",
    "bcer_geophysical_final_plans_1996_2004_no_handcut_aero",
    "bcer_pipeline_segments_2020",
    "bcgw_forest_tenure_road_sections",
    "bcgw_railway_track",
    "bcgw_transmission_lines",
}


def request_json(url, params, timeout=120):
    full_url = f"{url}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(full_url, headers={"User-Agent": "PGMaps BCEnviroScreen rebuild"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def layer_count(layer):
    data = request_json(
        f"{layer['url']}/query",
        {
            "where": layer["where"],
            "returnCountOnly": "true",
            "f": "json",
        },
    )
    if "error" in data:
        raise RuntimeError(f"ArcGIS count failed for {layer['id']}: {data['error']}")
    return int(data["count"])


def layer_page_size(layer):
    data = request_json(layer["url"], {"f": "json"})
    if "error" in data:
        raise RuntimeError(f"ArcGIS metadata failed for {layer['id']}: {data['error']}")
    max_record_count = int(data.get("maxRecordCount") or PAGE_SIZE)
    return min(PAGE_SIZE, max_record_count)


def download_layer(layer):
    layer_dir = OUTPUT_DIR / layer["id"]
    pages_dir = layer_dir / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)

    count = layer_count(layer)
    page_size = layer_page_size(layer)
    pages = math.ceil(count / page_size)
    downloaded = []

    for page_index in range(pages):
        offset = page_index * page_size
        page_path = pages_dir / f"page-{offset:07d}.geojson"
        if page_path.exists() and page_path.stat().st_size > 100:
            downloaded.append(page_path.name)
            continue

        data = request_json(
            f"{layer['url']}/query",
            {
                "where": layer["where"],
                "outFields": layer["out_fields"],
                "returnGeometry": "true",
                "outSR": OUT_SR,
                "f": "geojson",
                "resultOffset": offset,
                "resultRecordCount": page_size,
                "orderByFields": "OBJECTID ASC",
            },
        )
        if "error" in data:
            raise RuntimeError(f"ArcGIS page failed for {layer['id']} offset {offset}: {data['error']}")
        page_path.write_text(json.dumps(data, separators=(",", ":")) + "\n")
        downloaded.append(page_path.name)
        print(f"{layer['id']}: wrote {page_index + 1}/{pages} ({len(data.get('features', []))} features)")
        time.sleep(0.15)

    manifest = {
        "id": layer["id"],
        "name": layer["name"],
        "url": layer["url"],
        "where": layer["where"],
        "outFields": layer["out_fields"],
        "outSR": OUT_SR,
        "featureCount": count,
        "pageSize": page_size,
        "pageCount": pages,
        "pages": downloaded,
        "downloadedAt": datetime.now(timezone.utc).isoformat(),
    }
    (layer_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def parse_args():
    parser = argparse.ArgumentParser(
        description="Download paged BCEnviroScreen linear-footprint source layers."
    )
    parser.add_argument(
        "--layers",
        default="default",
        help=(
            "Comma-separated layer ids to download. Use 'default' for BCER+forest+rail+transmission "
            "or 'all' to include the very large Digital Road Atlas layer."
        ),
    )
    return parser.parse_args()


def selected_layers(layer_arg):
    by_id = {layer["id"]: layer for layer in LAYERS}
    if layer_arg == "default":
        ids = DEFAULT_LAYER_IDS
    elif layer_arg == "all":
        ids = set(by_id)
    else:
        ids = {item.strip() for item in layer_arg.split(",") if item.strip()}
    missing = sorted(ids - set(by_id))
    if missing:
        raise ValueError(f"Unknown layer id(s): {', '.join(missing)}")
    return [layer for layer in LAYERS if layer["id"] in ids]


def main():
    args = parse_args()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    manifests = []
    for layer in selected_layers(args.layers):
        manifests.append(download_layer(layer))

    root_manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "notes": [
            "Paged GeoJSON is stored in EPSG:3005 so line lengths can be measured directly in metres.",
            "These are live BC Energy Regulator ArcGIS services filtered to approximate the paper-era 2020 inputs where date fields exist.",
            "The default layer set downloads BCER, forest-tenure roads, railway, and transmission lines. Use --layers all to also download Digital Road Atlas roads.",
            "Trans Mountain pipeline is not included yet.",
        ],
        "layers": manifests,
    }
    (OUTPUT_DIR / "manifest.json").write_text(json.dumps(root_manifest, indent=2) + "\n")
    print(f"BCEnviroScreen linear-footprint sources: wrote {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
