#!/usr/bin/env python3
"""Build deterministic 50 m BC Freshwater Atlas watershed web snapshots."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import pathlib
import statistics
import subprocess
import tempfile
from collections import Counter
from dataclasses import dataclass
from typing import Any, Callable

import fiona
from fiona.transform import transform_geom
from shapely import STRtree, get_num_coordinates, make_valid, normalize
from shapely.geometry import MultiPolygon, Polygon, mapping, shape
from shapely.ops import unary_union


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
REPOSITORY_SOURCE = SCRIPT_DIR / "source/BCFWA/FWA_BC.zip"
SOURCE_GDB_NAME = "FWA_BC.gdb"
SOURCE_CRS = "EPSG:3005"
OUTPUT_CRS = "EPSG:4326"
MAPSHAPER_VERSION = "0.6.113"
DEFAULT_TOLERANCE_METRES = 50.0
DEFAULT_COORDINATE_PRECISION = 0.00001
MATERIAL_OVERLAP_AREA_M2 = 10.0
NAMED_STREAM_ORDERS = tuple(range(1, 11))


@dataclass(frozen=True)
class LayerConfig:
    key: str
    source_layer: str
    expected_feature_count: int
    output_name: str
    output_path: pathlib.Path
    id_property: str
    topology_profile: str
    intentional_overlap: bool
    schema_properties: dict[str, str]
    normalize_properties: Callable[[Any], dict[str, Any]]


def numeric_id(value: Any) -> int | None:
    return int(float(value)) if value is not None else None


def assessment_properties(properties: Any) -> dict[str, Any]:
    assessment_id = numeric_id(properties["WATERSHED_FEATURE_ID"])
    group_id = numeric_id(properties["WATERSHED_GROUP_ID"])
    if assessment_id is None or group_id is None:
        raise RuntimeError("Assessment watershed is missing a required ID")
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


def named_properties(properties: Any) -> dict[str, Any]:
    named_id = numeric_id(properties["NAMED_WATERSHED_ID"])
    if named_id is None:
        raise RuntimeError("Named watershed is missing NAMED_WATERSHED_ID")
    name = str(properties["GNIS_NAME"] or "").strip()
    return {
        "namedWatershedId": named_id,
        "boundaryCode": str(named_id),
        "boundaryName": name or str(named_id),
        "name": name or None,
        "gnisId": numeric_id(properties["GNIS_ID"]),
        "watershedKey": numeric_id(properties["WATERSHED_KEY"]),
        "blueLineKey": numeric_id(properties["BLUE_LINE_KEY"]),
        "streamOrder": numeric_id(properties["STREAM_ORDER"]),
        "streamMagnitude": numeric_id(properties["STREAM_MAGNITUDE"]),
        "areaKm2": round(float(properties["AREA_HA"]) / 100, 3),
    }


LAYERS = {
    "assessment": LayerConfig(
        key="assessment",
        source_layer="FWA_ASSESSMENT_WATERSHEDS_POLY",
        expected_feature_count=19_479,
        output_name="assessment_watersheds_province_50m",
        output_path=(
            SCRIPT_DIR
            / "output/BCFWA/assessment_watersheds_province_50m.geojson.gz"
        ),
        id_property="assessmentId",
        topology_profile="partition",
        intentional_overlap=False,
        schema_properties={
            "assessmentId": "int64",
            "watershedGroupId": "int64",
            "watershedGroupCode": "str:4",
            "boundaryCode": "str:24",
            "boundaryName": "str:80",
            "name": "str:80",
            "areaKm2": "float",
        },
        normalize_properties=assessment_properties,
    ),
    "named": LayerConfig(
        key="named",
        source_layer="FWA_NAMED_WATERSHEDS_POLY",
        expected_feature_count=11_580,
        output_name="named_watersheds_province_50m",
        output_path=(
            SCRIPT_DIR
            / "output/BCFWA/named_watersheds_province_50m.geojson.gz"
        ),
        id_property="namedWatershedId",
        topology_profile="overlapping",
        intentional_overlap=True,
        schema_properties={
            "namedWatershedId": "int64",
            "boundaryCode": "str:24",
            "boundaryName": "str:100",
            "name": "str:100",
            "gnisId": "int64",
            "watershedKey": "int64",
            "blueLineKey": "int64",
            "streamOrder": "int",
            "streamMagnitude": "int64",
            "areaKm2": "float",
        },
        normalize_properties=named_properties,
    ),
}


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
    parser.add_argument(
        "--layer",
        choices=["assessment", "named", "named-shards", "all"],
        default="all",
    )
    parser.add_argument("--source", type=pathlib.Path, default=default_source())
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument(
        "--tolerance-metres",
        type=float,
        default=DEFAULT_TOLERANCE_METRES,
    )
    parser.add_argument(
        "--coordinate-precision",
        type=float,
        default=DEFAULT_COORDINATE_PRECISION,
    )
    args = parser.parse_args()
    if args.output and args.layer in {"all", "named-shards"}:
        parser.error("--output requires a single --layer")
    return args


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_dataset_path(source_zip: pathlib.Path) -> str:
    return f"/vsizip/{source_zip.resolve()}/{SOURCE_GDB_NAME}"


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


def extract_projected_source(
    source_zip: pathlib.Path,
    extracted_path: pathlib.Path,
    config: LayerConfig,
) -> tuple[dict[int, float], int, int]:
    source_areas: dict[int, float] = {}
    source_coordinate_count = 0
    repaired_source_count = 0
    dataset = source_dataset_path(source_zip)
    schema = {
        "geometry": "Unknown",
        "properties": config.schema_properties,
    }

    with fiona.open(dataset, layer=config.source_layer) as source:
        if len(source) != config.expected_feature_count:
            raise RuntimeError(
                f"Expected {config.expected_feature_count:,} "
                f"{config.key} features, found {len(source):,}"
            )
        source_crs = source.crs.to_string()
        if source_crs != SOURCE_CRS:
            raise RuntimeError(
                f"Expected source CRS {SOURCE_CRS}, found {source_crs}"
            )

        with fiona.open(
            extracted_path,
            mode="w",
            driver="GeoJSON",
            schema=schema,
            crs=source.crs,
        ) as destination:
            for feature in source:
                properties = config.normalize_properties(
                    feature["properties"]
                )
                feature_id = int(properties[config.id_property])
                if feature_id in source_areas:
                    raise RuntimeError(
                        f"Duplicate {config.id_property} {feature_id}"
                    )
                if feature["geometry"] is None:
                    raise RuntimeError(
                        f"{config.key} feature {feature_id} has no geometry"
                    )
                geometry = shape(feature["geometry"])
                source_coordinate_count += int(
                    get_num_coordinates(geometry)
                )
                if not geometry.is_valid:
                    geometry = repair_polygonal_geometry(geometry)
                    repaired_source_count += 1
                source_areas[feature_id] = geometry.area
                destination.write(
                    {
                        "type": "Feature",
                        "id": feature_id,
                        "properties": properties,
                        "geometry": mapping(geometry),
                    }
                )

    return source_areas, source_coordinate_count, repaired_source_count


def simplify_with_mapshaper(
    extracted_path: pathlib.Path,
    simplified_path: pathlib.Path,
    config: LayerConfig,
    *,
    tolerance_metres: float,
    coordinate_precision: float,
) -> None:
    command = [
        "npx",
        "--yes",
        f"mapshaper@{MAPSHAPER_VERSION}",
        str(extracted_path),
    ]
    if config.topology_profile == "partition":
        command.append("-clean")
    command.extend(
        [
            "-simplify",
            "dp",
            f"interval={tolerance_metres}",
            "keep-shapes",
        ]
    )
    if config.topology_profile == "partition":
        command.append("-clean")
    command.extend(
        [
            "-proj",
            "wgs84",
            f"init={SOURCE_CRS}",
            "-o",
            "force",
            "format=geojson",
            f"precision={coordinate_precision}",
            str(simplified_path),
        ]
    )
    subprocess.run(command, check=True)


def projected_area(geometry: Any) -> float:
    transformed = transform_geom(
        OUTPUT_CRS,
        SOURCE_CRS,
        mapping(geometry),
        precision=-1,
    )
    return shape(transformed).area


def percentile(values: list[float], fraction: float) -> float:
    return values[round((len(values) - 1) * fraction)]


def validate_partition_overlaps(
    geometries: list[Any],
    feature_ids: list[int],
) -> dict[str, Any]:
    tree = STRtree(geometries)
    candidate_pairs = tree.query(geometries, predicate="intersects")
    positive_overlap_count = 0
    material_overlap_count = 0
    total_overlap_area = 0.0
    maximum_overlap_area = 0.0
    maximum_overlap_ids: tuple[int, int] | None = None

    for left_index, right_index in zip(*candidate_pairs):
        if left_index >= right_index:
            continue
        overlap = geometries[left_index].intersection(
            geometries[right_index]
        )
        if overlap.area <= 0:
            continue
        overlap_area = projected_area(overlap)
        positive_overlap_count += 1
        total_overlap_area += overlap_area
        if overlap_area >= MATERIAL_OVERLAP_AREA_M2:
            material_overlap_count += 1
        if overlap_area > maximum_overlap_area:
            maximum_overlap_area = overlap_area
            maximum_overlap_ids = (
                feature_ids[left_index],
                feature_ids[right_index],
            )

    if material_overlap_count:
        raise RuntimeError(
            f"Found {material_overlap_count} assessment watershed overlap "
            f"pairs at or above {MATERIAL_OVERLAP_AREA_M2:g} m²"
        )

    return {
        "strategy": "Positive-area pairwise intersections",
        "materialOverlapThresholdM2": MATERIAL_OVERLAP_AREA_M2,
        "positiveAreaPairCount": positive_overlap_count,
        "materialOverlapPairCount": material_overlap_count,
        "totalOverlapAreaM2": round(total_overlap_area, 6),
        "maximumOverlapAreaM2": round(maximum_overlap_area, 6),
        "maximumOverlapFeatureIds": (
            list(maximum_overlap_ids) if maximum_overlap_ids else None
        ),
    }


def validate_features(
    features: list[dict[str, Any]],
    config: LayerConfig,
    source_areas: dict[int, float],
    source_coordinate_count: int,
    repaired_source_count: int,
) -> dict[str, Any]:
    ids: set[int] = set()
    geometry_types: Counter[str] = Counter()
    coordinate_count = 0
    repaired_output_count = 0
    area_changes: list[tuple[float, float, float, int]] = []
    output_geometries: list[Any] = []
    output_feature_ids: list[int] = []

    for feature in features:
        properties = feature.get("properties") or {}
        feature_id = int(properties[config.id_property])
        if feature_id in ids:
            raise RuntimeError(
                f"Duplicate output {config.id_property} {feature_id}"
            )
        if feature_id not in source_areas:
            raise RuntimeError(f"Unexpected output feature {feature_id}")
        ids.add(feature_id)
        feature["id"] = feature_id

        geometry = shape(feature["geometry"])
        if geometry.is_empty:
            raise RuntimeError(f"Empty output geometry {feature_id}")
        if not geometry.is_valid:
            geometry = repair_polygonal_geometry(geometry)
            feature["geometry"] = mapping(geometry)
            repaired_output_count += 1
        geometry_types[geometry.geom_type] += 1
        coordinate_count += int(get_num_coordinates(geometry))
        output_geometries.append(geometry)
        output_feature_ids.append(feature_id)
        source_area = source_areas[feature_id]
        absolute_area_change = abs(
            projected_area(geometry) - source_area
        )
        percent_area_change = (
            absolute_area_change / source_area * 100 if source_area else 0
        )
        area_changes.append(
            (
                percent_area_change,
                absolute_area_change,
                source_area,
                feature_id,
            )
        )

    if len(features) != config.expected_feature_count:
        raise RuntimeError(
            f"Expected {config.expected_feature_count:,} output features, "
            f"found {len(features):,}"
        )
    missing_ids = set(source_areas) - ids
    if missing_ids:
        raise RuntimeError(
            f"Missing output IDs: {sorted(missing_ids)[:10]}"
        )

    area_changes.sort()
    area_values = [record[0] for record in area_changes]
    (
        worst_area_change,
        _,
        worst_source_area,
        worst_area_change_id,
    ) = area_changes[-1]
    (
        _,
        worst_absolute_area_change,
        worst_absolute_source_area,
        worst_absolute_area_change_id,
    ) = max(area_changes, key=lambda record: record[1])
    material_area_changes = [
        record for record in area_changes if record[2] >= 1_000_000
    ]
    (
        worst_material_area_change,
        _,
        worst_material_source_area,
        worst_material_area_change_id,
    ) = max(material_area_changes, key=lambda record: record[0])
    validation: dict[str, Any] = {
        "featureCount": len(features),
        "sourceCoordinateCount": source_coordinate_count,
        "coordinateCount": coordinate_count,
        "coordinateReductionPercent": round(
            (1 - coordinate_count / source_coordinate_count) * 100,
            6,
        ),
        "geometryTypes": dict(sorted(geometry_types.items())),
        "repairedSourceGeometryCount": repaired_source_count,
        "repairedOutputGeometryCount": repaired_output_count,
        "invalidGeometryCount": 0,
        "emptyGeometryCount": 0,
        "areaChangePercent": {
            "median": round(statistics.median(area_values), 6),
            "p95": round(percentile(area_values, 0.95), 6),
            "maximum": round(worst_area_change, 6),
            "maximumFeatureId": worst_area_change_id,
            "maximumSourceAreaKm2": round(
                worst_source_area / 1_000_000,
                6,
            ),
            "maximumForFeaturesAtLeast1Km2": round(
                worst_material_area_change,
                6,
            ),
            "maximumForFeaturesAtLeast1Km2FeatureId": (
                worst_material_area_change_id
            ),
            "maximumForFeaturesAtLeast1Km2SourceAreaKm2": round(
                worst_material_source_area / 1_000_000,
                6,
            ),
            "maximumAbsoluteChangeKm2": round(
                worst_absolute_area_change / 1_000_000,
                6,
            ),
            "maximumAbsoluteChangeFeatureId": (
                worst_absolute_area_change_id
            ),
            "maximumAbsoluteChangeSourceAreaKm2": round(
                worst_absolute_source_area / 1_000_000,
                6,
            ),
        },
    }

    if config.topology_profile == "partition":
        validation["overlapValidation"] = validate_partition_overlaps(
            output_geometries,
            output_feature_ids,
        )

    if config.key == "named":
        nechako = next(
            (
                feature
                for feature in features
                if feature["properties"]["namedWatershedId"] == 8_886
            ),
            None,
        )
        if (
            not nechako
            or nechako["properties"]["boundaryName"] != "Nechako River"
        ):
            raise RuntimeError(
                "Expected named watershed 8886 to be Nechako River"
            )
        nechako_geometry = shape(nechako["geometry"])
        nested_count = sum(
            feature["id"] != 8_886
            and nechako_geometry.covers(
                shape(feature["geometry"]).representative_point()
            )
            for feature in features
        )
        validation["nechako"] = {
            "namedWatershedId": 8_886,
            "areaKm2": nechako["properties"]["areaKm2"],
            "nestedRepresentativePointCount": nested_count,
        }

    return validation


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


def deterministic_json_payload(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def named_stream_order_output_path(
    full_output_path: pathlib.Path,
    stream_order: int,
) -> pathlib.Path:
    return (
        full_output_path.parent
        / f"named_watersheds_stream_order_{stream_order}_50m.geojson.gz"
    )


def write_named_stream_order_shards(
    collection: dict[str, Any],
    full_output_path: pathlib.Path,
    *,
    full_raw_bytes: int,
) -> dict[str, Any]:
    features = collection.get("features") or []
    if len(features) != LAYERS["named"].expected_feature_count:
        raise RuntimeError(
            "Named stream-order sharding requires the complete "
            f"{LAYERS['named'].expected_feature_count:,}-feature snapshot"
        )

    features_by_order: dict[int, list[dict[str, Any]]] = {
        stream_order: [] for stream_order in NAMED_STREAM_ORDERS
    }
    for feature in features:
        stream_order = int(feature["properties"]["streamOrder"])
        if stream_order not in features_by_order:
            raise RuntimeError(
                f"Unexpected named watershed stream order {stream_order}"
            )
        features_by_order[stream_order].append(feature)

    shards: list[dict[str, Any]] = []
    for stream_order in NAMED_STREAM_ORDERS:
        order_features = features_by_order[stream_order]
        output_path = named_stream_order_output_path(
            full_output_path,
            stream_order,
        )
        order_collection = {
            "type": "FeatureCollection",
            "name": f"named_watersheds_stream_order_{stream_order}_50m",
            "metadata": {
                **(collection.get("metadata") or {}),
                "scope": f"Province-wide stream order {stream_order}",
                "streamOrder": stream_order,
                "featureCount": len(order_features),
                "parentSnapshot": full_output_path.name,
                "parentFeatureCount": len(features),
            },
            "features": order_features,
        }
        payload = deterministic_json_payload(order_collection)
        deterministic_gzip(payload, output_path)
        shards.append(
            {
                "streamOrder": stream_order,
                "path": output_path.name,
                "features": len(order_features),
                "rawBytes": len(payload),
                "gzipBytes": output_path.stat().st_size,
                "gzipSha256": sha256_file(output_path),
            }
        )

    if sum(shard["features"] for shard in shards) != len(features):
        raise RuntimeError("Named stream-order shard feature counts do not sum")

    manifest = {
        "schemaVersion": 1,
        "source": collection.get("metadata", {}).get("source"),
        "sourceLayer": collection.get("metadata", {}).get("sourceLayer"),
        "simplificationToleranceMetres": collection.get("metadata", {}).get(
            "simplificationToleranceMetres"
        ),
        "parentSnapshot": {
            "path": full_output_path.name,
            "features": len(features),
            "rawBytes": full_raw_bytes,
            "gzipBytes": full_output_path.stat().st_size,
            "gzipSha256": sha256_file(full_output_path),
        },
        "orders": shards,
    }
    manifest_path = (
        full_output_path.parent
        / "named_watersheds_stream_orders_manifest.json"
    )
    manifest_path.write_bytes(deterministic_json_payload(manifest))
    return {
        "manifest": str(manifest_path),
        "orders": shards,
    }


def build_layer(
    config: LayerConfig,
    source_zip: pathlib.Path,
    output_path: pathlib.Path,
    *,
    tolerance_metres: float,
    coordinate_precision: float,
    source_sha256: str,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(
        prefix=f"bc-fwa-{config.key}-50m-"
    ) as temp:
        temp_dir = pathlib.Path(temp)
        extracted_path = temp_dir / f"{config.key}_epsg3005.geojson"
        simplified_path = temp_dir / f"{config.key}_50m_wgs84.geojson"
        (
            source_areas,
            source_coordinate_count,
            repaired_source_count,
        ) = extract_projected_source(source_zip, extracted_path, config)
        simplify_with_mapshaper(
            extracted_path,
            simplified_path,
            config,
            tolerance_metres=tolerance_metres,
            coordinate_precision=coordinate_precision,
        )
        simplified = json.loads(
            simplified_path.read_text(encoding="utf-8")
        )

    features = simplified.get("features") or []
    features.sort(
        key=lambda feature: int(
            feature["properties"][config.id_property]
        )
    )
    validation = validate_features(
        features,
        config,
        source_areas,
        source_coordinate_count,
        repaired_source_count,
    )
    collection = {
        "type": "FeatureCollection",
        "name": config.output_name,
        "metadata": {
            "source": "Government of British Columbia Freshwater Atlas",
            "sourceArchive": source_zip.name,
            "sourceSha256": source_sha256,
            "sourceLayer": config.source_layer,
            "scope": "Province-wide",
            "nativeCrs": SOURCE_CRS,
            "outputCrs": OUTPUT_CRS,
            "simplification": (
                "Mapshaper shared-topology Ramer-Douglas-Peucker"
            ),
            "topologyProfile": config.topology_profile,
            "intentionalOverlap": config.intentional_overlap,
            "cleaningApplied": config.topology_profile == "partition",
            "simplificationToleranceMetres": tolerance_metres,
            "coordinatePrecisionDegrees": coordinate_precision,
            "mapshaperVersion": MAPSHAPER_VERSION,
            **validation,
        },
        "features": features,
    }
    payload = deterministic_json_payload(collection)
    deterministic_gzip(payload, output_path)
    result = {
        "layer": config.key,
        "output": str(output_path),
        "rawBytes": len(payload),
        "gzipBytes": output_path.stat().st_size,
        "gzipSha256": sha256_file(output_path),
        **validation,
    }
    if config.key == "named":
        result["streamOrderShards"] = write_named_stream_order_shards(
            collection,
            output_path,
            full_raw_bytes=len(payload),
        )
    return result


def main() -> None:
    args = parse_args()
    if args.layer == "named-shards":
        output_path = LAYERS["named"].output_path.resolve()
        if not output_path.is_file():
            raise FileNotFoundError(
                f"Missing {output_path}. Build the named snapshot first."
            )
        with gzip.open(output_path, "rt", encoding="utf-8") as handle:
            collection = json.load(handle)
        result = write_named_stream_order_shards(
            collection,
            output_path,
            full_raw_bytes=len(deterministic_json_payload(collection)),
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return

    source_zip = args.source.resolve()
    if not source_zip.is_file():
        raise FileNotFoundError(
            f"Missing {source_zip}. Restore it using source/BCFWA/README.md."
        )
    source_sha256 = sha256_file(source_zip)
    selected = list(LAYERS) if args.layer == "all" else [args.layer]
    results = []
    for layer_key in selected:
        config = LAYERS[layer_key]
        output_path = (
            args.output.resolve()
            if args.output
            else config.output_path.resolve()
        )
        results.append(
            build_layer(
                config,
                source_zip,
                output_path,
                tolerance_metres=args.tolerance_metres,
                coordinate_precision=args.coordinate_precision,
                source_sha256=source_sha256,
            )
        )
    print(json.dumps(results, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
