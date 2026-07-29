#!/usr/bin/env python3
"""Build the full-province 50 m FWA assessment-watershed web snapshot.

The source FileGDB remains in its downloaded ZIP. Fiona extracts the assessment
layer to a temporary projected GeoJSON, then pinned mapshaper performs one
shared-topology simplification before reprojection to WGS84. The only durable
artifact is a deterministic gzip-compressed GeoJSON.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
from collections import Counter
from typing import Any

import fiona
from shapely import get_num_coordinates, make_valid, normalize
from shapely.geometry import MultiPolygon, Polygon, mapping, shape
from shapely.ops import unary_union


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
REPOSITORY_SOURCE = SCRIPT_DIR / "source/BCFWA/FWA_BC.zip"
DEFAULT_OUTPUT = (
    SCRIPT_DIR
    / "output/BCFWA/assessment_watersheds_province_50m.geojson.gz"
)
SOURCE_GDB_NAME = "FWA_BC.gdb"
SOURCE_LAYER = "FWA_ASSESSMENT_WATERSHEDS_POLY"
SOURCE_CRS = "EPSG:3005"
OUTPUT_CRS = "EPSG:4326"
MAPSHAPER_VERSION = "0.6.113"
EXPECTED_FEATURE_COUNT = 19_479


def default_source() -> pathlib.Path:
    configured_dir = os.environ.get("BCFWA_SOURCE_DIR")
    if configured_dir:
        return pathlib.Path(configured_dir).expanduser() / "FWA_BC.zip"
    if REPOSITORY_SOURCE.is_file():
        return REPOSITORY_SOURCE
    drive_pattern = (
        "Library/CloudStorage/GoogleDrive-*/My Drive/University/Research/"
        "Grad/Data/Boundaries/BCFWA/FWA_BC.zip"
    )
    drive_matches = sorted(pathlib.Path.home().glob(drive_pattern))
    if len(drive_matches) == 1:
        return drive_matches[0]
    return REPOSITORY_SOURCE


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, default=default_source())
    parser.add_argument("--output", type=pathlib.Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--tolerance-metres", type=float, default=50.0)
    parser.add_argument("--coordinate-precision", type=float, default=0.00001)
    return parser.parse_args()


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def numeric_id(value: Any) -> int:
    return int(float(value))


def source_dataset_path(source_zip: pathlib.Path) -> str:
    return f"/vsizip/{source_zip.resolve()}/{SOURCE_GDB_NAME}"


def normalized_properties(properties: Any) -> dict[str, Any]:
    assessment_id = numeric_id(properties["WATERSHED_FEATURE_ID"])
    group_id = numeric_id(properties["WATERSHED_GROUP_ID"])
    group_code = str(properties["WATERSHED_GROUP_CODE"] or "").strip()
    primary_name = str(properties["GNIS_NAME_1"] or "").strip()
    fallback_name = (
        primary_name
        or str(properties["GNIS_NAME_2"] or "").strip()
        or str(properties["GNIS_NAME_3"] or "").strip()
        or str(assessment_id)
    )
    return {
        "assessmentId": assessment_id,
        "watershedGroupId": group_id,
        "watershedGroupCode": group_code,
        "boundaryCode": str(assessment_id),
        "boundaryName": fallback_name,
        "name": primary_name or None,
        "areaKm2": round(float(properties["AREA_HA"]) / 100, 3),
    }


def extract_projected_source(
    source_zip: pathlib.Path, extracted_path: pathlib.Path
) -> tuple[int, str]:
    dataset = source_dataset_path(source_zip)
    with fiona.open(dataset, layer=SOURCE_LAYER) as source:
        source_count = len(source)
        source_crs = source.crs.to_string()
        schema = {
            "geometry": "Unknown",
            "properties": {
                "assessmentId": "int64",
                "watershedGroupId": "int64",
                "watershedGroupCode": "str:4",
                "boundaryCode": "str:24",
                "boundaryName": "str:80",
                "name": "str:80",
                "areaKm2": "float",
            },
        }
        with fiona.open(
            extracted_path,
            mode="w",
            driver="GeoJSON",
            schema=schema,
            crs=source.crs,
        ) as destination:
            for feature in source:
                if feature["geometry"] is None:
                    raise RuntimeError(
                        f"Feature {feature['id']} has no geometry"
                    )
                properties = normalized_properties(feature["properties"])
                destination.write(
                    {
                        "type": "Feature",
                        "id": properties["assessmentId"],
                        "properties": properties,
                        "geometry": feature["geometry"],
                    }
                )
    return source_count, source_crs


def simplify_shared_topology(
    extracted_path: pathlib.Path,
    simplified_path: pathlib.Path,
    *,
    tolerance_metres: float,
    coordinate_precision: float,
) -> None:
    subprocess.run(
        [
            "npx",
            "--yes",
            f"mapshaper@{MAPSHAPER_VERSION}",
            str(extracted_path),
            "-clean",
            "-simplify",
            "dp",
            f"interval={tolerance_metres}",
            "keep-shapes",
            "-clean",
            "-proj",
            "wgs84",
            f"init={SOURCE_CRS}",
            "-o",
            "force",
            "format=geojson",
            f"precision={coordinate_precision}",
            str(simplified_path),
        ],
        check=True,
    )


def polygonal_parts(geometry: Any) -> list[Polygon]:
    if isinstance(geometry, Polygon):
        return [geometry]
    if isinstance(geometry, MultiPolygon):
        return list(geometry.geoms)
    parts: list[Polygon] = []
    for child in getattr(geometry, "geoms", []):
        parts.extend(polygonal_parts(child))
    return parts


def repair_polygonal_geometry(geometry: Any) -> Any:
    repaired = make_valid(geometry)
    parts = polygonal_parts(repaired)
    if not parts:
        raise RuntimeError("Geometry repair produced no polygonal components")
    merged = parts[0] if len(parts) == 1 else unary_union(parts)
    if merged.geom_type not in {"Polygon", "MultiPolygon"}:
        raise RuntimeError(
            f"Geometry repair produced unexpected {merged.geom_type}"
        )
    return normalize(merged)


def validate_features(features: list[dict[str, Any]]) -> dict[str, Any]:
    ids: set[int] = set()
    invalid_ids: list[int] = []
    empty_ids: list[int] = []
    geometry_types: Counter[str] = Counter()
    coordinate_count = 0
    repaired_count = 0

    for feature in features:
        properties = feature.get("properties") or {}
        assessment_id = numeric_id(properties["assessmentId"])
        if assessment_id in ids:
            raise RuntimeError(f"Duplicate assessmentId {assessment_id}")
        ids.add(assessment_id)
        feature["id"] = assessment_id

        geometry = shape(feature["geometry"])
        if not geometry.is_valid:
            geometry = repair_polygonal_geometry(geometry)
            feature["geometry"] = mapping(geometry)
            repaired_count += 1
        geometry_types[geometry.geom_type] += 1
        coordinate_count += int(get_num_coordinates(geometry))
        if geometry.is_empty:
            empty_ids.append(assessment_id)
        if not geometry.is_valid:
            invalid_ids.append(assessment_id)

    if len(features) != EXPECTED_FEATURE_COUNT:
        raise RuntimeError(
            f"Expected {EXPECTED_FEATURE_COUNT:,} features, "
            f"found {len(features):,}"
        )
    if empty_ids:
        raise RuntimeError(f"Empty output geometries: {empty_ids[:10]}")
    if invalid_ids:
        raise RuntimeError(f"Invalid output geometries: {invalid_ids[:10]}")

    return {
        "featureCount": len(features),
        "coordinateCount": coordinate_count,
        "geometryTypes": dict(sorted(geometry_types.items())),
        "repairedGeometryCount": repaired_count,
        "invalidGeometryCount": len(invalid_ids),
        "emptyGeometryCount": len(empty_ids),
    }


def deterministic_gzip(payload: bytes, output_path: pathlib.Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("wb") as raw_handle:
        with gzip.GzipFile(
            filename="",
            mode="wb",
            fileobj=raw_handle,
            compresslevel=9,
            mtime=0,
        ) as gzip_handle:
            gzip_handle.write(payload)


def main() -> None:
    args = parse_args()
    source_zip = args.source.resolve()
    output_path = args.output.resolve()
    if not source_zip.is_file():
        raise FileNotFoundError(
            f"Missing {source_zip}. Restore it using source/BCFWA/README.md."
        )

    source_sha256 = sha256_file(source_zip)
    with tempfile.TemporaryDirectory(prefix="bc-fwa-assessment-50m-") as temp:
        temp_dir = pathlib.Path(temp)
        extracted_path = temp_dir / "assessment_epsg3005.geojson"
        simplified_path = temp_dir / "assessment_50m_wgs84.geojson"
        source_count, source_crs = extract_projected_source(
            source_zip, extracted_path
        )
        if source_count != EXPECTED_FEATURE_COUNT:
            raise RuntimeError(
                f"Expected {EXPECTED_FEATURE_COUNT:,} source features, "
                f"found {source_count:,}"
            )
        if source_crs != SOURCE_CRS:
            raise RuntimeError(
                f"Expected source CRS {SOURCE_CRS}, found {source_crs}"
            )

        simplify_shared_topology(
            extracted_path,
            simplified_path,
            tolerance_metres=args.tolerance_metres,
            coordinate_precision=args.coordinate_precision,
        )
        simplified = json.loads(simplified_path.read_text(encoding="utf-8"))

    features = simplified.get("features") or []
    features.sort(
        key=lambda feature: numeric_id(
            feature["properties"]["assessmentId"]
        )
    )
    validation = validate_features(features)
    collection = {
        "type": "FeatureCollection",
        "name": "assessment_watersheds_province_50m",
        "metadata": {
            "source": "Government of British Columbia Freshwater Atlas",
            "sourceArchive": source_zip.name,
            "sourceSha256": source_sha256,
            "sourceLayer": SOURCE_LAYER,
            "scope": "Province-wide",
            "nativeCrs": SOURCE_CRS,
            "outputCrs": OUTPUT_CRS,
            "simplification": "Shared-topology Ramer-Douglas-Peucker",
            "simplificationToleranceMetres": args.tolerance_metres,
            "coordinatePrecisionDegrees": args.coordinate_precision,
            "mapshaperVersion": MAPSHAPER_VERSION,
            **validation,
        },
        "features": features,
    }
    payload = (
        json.dumps(
            collection,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")
    deterministic_gzip(payload, output_path)

    print(
        json.dumps(
            {
                "output": str(output_path),
                "rawBytes": len(payload),
                "gzipBytes": output_path.stat().st_size,
                "gzipSha256": sha256_file(output_path),
                **validation,
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
