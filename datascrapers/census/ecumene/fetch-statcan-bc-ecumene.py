#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pyproj>=3.7,<4",
#   "shapely>=2.1,<3",
# ]
# ///

"""Fetch and clip the official 2021 Statistics Canada population ecumene to BC."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

from pyproj import Transformer
from shapely import set_precision
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, mapping, shape
from shapely.ops import transform, unary_union
from shapely.strtree import STRtree
from shapely.validation import make_valid


STATCAN_ECUMENE_LAYER = (
    "https://geo.statcan.gc.ca/geo_wa/rest/services/2021/"
    "Population_ecumene_boundary_files/MapServer/2/query"
)
STATCAN_PROVINCE_LAYER = (
    "https://geo.statcan.gc.ca/geo_wa/rest/services/2021/"
    "Digital_boundary_files/MapServer/0/query"
)
DEFAULT_OUTPUT_DIR = Path(__file__).resolve().parents[1] / "output" / "ecumene"
BC_QUERY_BBOX = "-139.2,48.0,-114.0,60.1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    return parser.parse_args()


def fetch_geojson(url: str, params: dict[str, str]) -> dict:
    request_url = f"{url}?{urlencode(params)}"
    with urlopen(request_url, timeout=120) as response:  # noqa: S310 - fixed official URLs
        payload = json.load(response)
    if payload.get("error"):
        raise RuntimeError(f"Statistics Canada service error: {payload['error']}")
    if payload.get("type") != "FeatureCollection":
        raise RuntimeError(f"Unexpected Statistics Canada response: {payload.keys()}")
    return payload


def valid(geometry):
    return geometry if geometry.is_valid else make_valid(geometry)


def polygonal(geometry):
    geometry = valid(geometry)
    if isinstance(geometry, (Polygon, MultiPolygon)):
        return geometry
    if isinstance(geometry, GeometryCollection):
        parts = [part for part in geometry.geoms if isinstance(part, (Polygon, MultiPolygon))]
        return unary_union(parts) if parts else GeometryCollection()
    return GeometryCollection()


def deterministic_gzip(data: bytes) -> bytes:
    output = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=output, compresslevel=9, mtime=0) as stream:
        stream.write(data)
    return output.getvalue()


def overlap_profile(features: list[dict]) -> dict:
    transformer = Transformer.from_crs("EPSG:4326", "EPSG:3005", always_xy=True)
    geometries = [transform(transformer.transform, shape(feature["geometry"])) for feature in features]
    tree = STRtree(geometries)
    pair_count = 0
    overlap_area = 0.0
    overlapping_ids = []
    for left_index, left in enumerate(geometries):
        for right_index_raw in tree.query(left):
            right_index = int(right_index_raw)
            if right_index <= left_index:
                continue
            area = left.intersection(geometries[right_index]).area
            if area <= 0.01:
                continue
            pair_count += 1
            overlap_area += area
            overlapping_ids.append(
                [
                    features[left_index]["properties"]["ECUID"],
                    features[right_index]["properties"]["ECUID"],
                ]
            )
    return {
        "validFeatureCount": sum(geometry.is_valid for geometry in geometries),
        "emptyFeatureCount": sum(geometry.is_empty for geometry in geometries),
        "uniqueEcuidCount": len({feature["properties"]["ECUID"] for feature in features}),
        "overlapPairCount": pair_count,
        "overlapAreaKm2": round(overlap_area / 1_000_000, 6),
        "overlappingEcuidPairs": overlapping_ids,
        "overlapNote": "Source ECUID polygons are preserved; consumers should union them when using the product as a mask.",
    }


def main() -> None:
    args = parse_args()
    province = fetch_geojson(
        STATCAN_PROVINCE_LAYER,
        {
            "where": "PRUID='59'",
            "outFields": "PRUID,PRENAME,PRFNAME",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "geojson",
        },
    )
    if len(province["features"]) != 1:
        raise RuntimeError(f"Expected one BC province feature, got {len(province['features'])}")
    bc_geometry = valid(shape(province["features"][0]["geometry"]))

    source = fetch_geojson(
        STATCAN_ECUMENE_LAYER,
        {
            "where": "ECUMENE='1'",
            "geometry": BC_QUERY_BBOX,
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "ECUID,ECUMENE",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "geojson",
        },
    )

    features = []
    for feature in source["features"]:
        clipped = polygonal(valid(shape(feature["geometry"])).intersection(bc_geometry))
        if clipped.is_empty:
            continue
        clipped = set_precision(clipped, grid_size=0.000001, mode="valid_output")
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "ECUID": str(feature["properties"]["ECUID"]),
                    "ECUMENE": "1",
                },
                "geometry": mapping(clipped),
            }
        )

    features.sort(key=lambda feature: feature["properties"]["ECUID"])
    collection = {
        "type": "FeatureCollection",
        "name": "Statistics Canada 2021 population ecumene - British Columbia",
        "features": features,
    }
    raw = (json.dumps(collection, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    compressed = deterministic_gzip(raw)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    data_name = "statcan-bc-population-ecumene-2021.geojson.gz"
    data_path = args.output_dir / data_name
    data_path.write_bytes(compressed)

    bounds = unary_union([shape(feature["geometry"]) for feature in features]).bounds
    manifest = {
        "dataset": "Statistics Canada 2021 Population Ecumene Boundary Files",
        "coverage": "British Columbia",
        "sourceReleaseDate": "2022-02-09",
        "sourceLayer": STATCAN_ECUMENE_LAYER.removesuffix("/query"),
        "provinceClipLayer": STATCAN_PROVINCE_LAYER.removesuffix("/query"),
        "sourceCrs": "EPSG:4326",
        "outputCrs": "EPSG:4326",
        "licence": "Open Government Licence - Canada",
        "featureCount": len(features),
        "bbox": [round(value, 6) for value in bounds],
        "rawBytes": len(raw),
        "gzipBytes": len(compressed),
        "sha256": hashlib.sha256(compressed).hexdigest(),
        "validation": overlap_profile(features),
        "files": {"ecumene": data_name},
    }
    manifest_path = args.output_dir / "statcan-bc-population-ecumene-2021.manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
