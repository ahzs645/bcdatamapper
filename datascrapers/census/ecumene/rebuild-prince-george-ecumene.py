#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy>=2,<3",
#   "pyproj>=3.7,<4",
#   "pyshp>=2.3,<3",
#   "rasterio>=1.4,<2",
#   "scipy>=1.16,<2",
#   "shapely>=2.1,<3",
# ]
# ///

"""Rebuild a Laval-style residential ecumene for the Prince George city pilot."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import math
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import rasterio
import shapefile
from pyproj import Transformer
from rasterio.features import rasterize, shapes as raster_shapes
from rasterio.windows import from_bounds
from scipy.spatial import Delaunay
from shapely import coverage_union_all, set_precision
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, mapping, shape
from shapely.ops import transform, unary_union
from shapely.strtree import STRtree
from shapely.validation import make_valid


SCRIPT_DIR = Path(__file__).resolve().parent
CENSUS_DIR = SCRIPT_DIR.parent
DEFAULT_DB = SCRIPT_DIR / ".cache" / "statcan" / "prince-george-city-db-2021-full.geojson.gz"
DEFAULT_DA = SCRIPT_DIR / ".cache" / "statcan" / "prince-george-city-da-2021-full.geojson.gz"
DEFAULT_CMA = SCRIPT_DIR / ".cache" / "statcan" / "prince-george-cma-2021-full.geojson.gz"
DEFAULT_OUTPUT_DIR = CENSUS_DIR / "output" / "ecumene"
DEFAULT_CACHE = SCRIPT_DIR / ".cache" / "ghsl"
GHSL_TILE_NAME = "GHS_BUILT_C_FUN_E2018_GLOBE_R2022A_54009_10_V1_0_R3_C10"
GHSL_TILE_URL = (
    "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/"
    "GHS_BUILT_C_GLOBE_R2022A/GHS_BUILT_C_FUN_GLOBE_R2022A/"
    "GHS_BUILT_C_FUN_E2018_GLOBE_R2022A_54009_10/V1-0/tiles/"
    f"{GHSL_TILE_NAME}.zip"
)
GHSL_ZIP_SHA256 = "b1a0eb591291e7e797dc64eb71940c33a1030371cb5155cc147d43ae7fc9b7e0"
MOLLWEIDE = "ESRI:54009"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db-geojson", type=Path, default=DEFAULT_DB)
    parser.add_argument("--da-geojson", type=Path, default=DEFAULT_DA)
    parser.add_argument("--cma-geojson", type=Path, default=DEFAULT_CMA)
    parser.add_argument("--ghsl-tif", type=Path)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--laval-shapefile", type=Path)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--working-crs", default="EPSG:3347")
    parser.add_argument("--hex-area", type=float, default=10_000)
    parser.add_argument(
        "--hex-origin-x",
        type=float,
        default=None,
        help="X coordinate of an even-column hex centre in the working CRS",
    )
    parser.add_argument(
        "--hex-origin-y",
        type=float,
        default=None,
        help="Y coordinate of an even-column hex centre in the working CRS",
    )
    parser.add_argument("--triangle-perimeter", type=float, default=350)
    parser.add_argument(
        "--hex-selection-method",
        choices=("vector-intersection", "raster-label"),
        default="vector-intersection",
    )
    parser.add_argument(
        "--smoothing-method",
        choices=("none", "buffer-close", "bezier-approximation", "chaikin-approximation"),
        default="chaikin-approximation",
    )
    parser.add_argument("--smooth", type=float, default=60)
    parser.add_argument("--bezier-subdivisions", type=int, default=4)
    parser.add_argument("--chaikin-iterations", type=int, default=2)
    parser.add_argument("--chaikin-ratio", type=float, default=0.35)
    parser.add_argument("--simplify", type=float, default=0)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def acquire_ghsl(cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    archive = cache_dir / f"{GHSL_TILE_NAME}.zip"
    tif = cache_dir / f"{GHSL_TILE_NAME}.tif"
    if tif.exists():
        return tif
    if not archive.exists():
        print(f"Downloading {GHSL_TILE_URL}")
        urllib.request.urlretrieve(GHSL_TILE_URL, archive)  # noqa: S310 - fixed official URL
    actual_hash = sha256(archive)
    if actual_hash != GHSL_ZIP_SHA256:
        raise RuntimeError(f"GHSL archive checksum mismatch: {actual_hash}")
    with zipfile.ZipFile(archive) as source:
        source.extract(f"{GHSL_TILE_NAME}.tif", cache_dir)
    return tif


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


def transform_geometry(geometry, transformer: Transformer):
    return valid(transform(transformer.transform, geometry))


def load_geojson(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(path)
    if path.suffix == ".gz":
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            return json.load(stream)
    return json.loads(path.read_text(encoding="utf-8"))


def load_db_geometries(path: Path, transformer: Transformer):
    source = load_geojson(path)
    all_geometries = []
    inhabited_geometries = []
    da_ids = set()
    for feature in source["features"]:
        properties = feature.get("properties") or {}
        da_id = str(properties.get("parentDaId") or "").strip()
        if da_id:
            da_ids.add(da_id)
        geometry = transform_geometry(shape(feature["geometry"]), transformer)
        all_geometries.append(geometry)
        if float(properties.get("population") or 0) > 0:
            inhabited_geometries.append(geometry)
    if not all_geometries or not inhabited_geometries:
        raise RuntimeError("DB input did not contain usable populated geometries")
    return da_ids, unary_union(all_geometries), unary_union(inhabited_geometries), len(source["features"]), len(inhabited_geometries)


def load_da_geometries(path: Path, transformer: Transformer, include_ids: set[str]):
    source = load_geojson(path)
    geometries = {}
    for feature in source["features"]:
        properties = feature.get("properties") or {}
        da_id = str(properties.get("id") or properties.get("DAUID") or properties.get("boundaryCode") or "").strip()
        if da_id in include_ids:
            geometries[da_id] = transform_geometry(shape(feature["geometry"]), transformer)
    missing = sorted(include_ids - geometries.keys())
    if missing:
        raise RuntimeError(f"Missing DA geometries for {len(missing)} IDs; examples: {missing[:5]}")
    return geometries


def load_grid_origin(path: Path, transformer: Transformer) -> tuple[float, float]:
    source = load_geojson(path)
    geometries = [transform_geometry(shape(feature["geometry"]), transformer) for feature in source["features"]]
    if len(geometries) != 1:
        raise RuntimeError(f"Expected exactly one CMA/CA geometry in {path}, found {len(geometries)}")
    minx, miny, _, _ = geometries[0].bounds
    return minx, miny


def generate_flat_hexagons(bounds, area: float, origin_x: float = 0, origin_y: float = 0):
    minx, miny, maxx, maxy = bounds
    side = math.sqrt(2 * area / (3 * math.sqrt(3)))
    height = math.sqrt(3) * side
    x_step = 1.5 * side
    first_column = math.floor((minx - side - origin_x) / x_step)
    hexagons = []
    column = first_column
    x = origin_x + column * x_step
    while x - side <= maxx:
        column_origin_y = origin_y + (height / 2 if column % 2 else 0)
        first_row = math.floor((miny - height / 2 - column_origin_y) / height)
        y = column_origin_y + first_row * height
        while y - height / 2 <= maxy:
            if y + height / 2 >= miny:
                points = [
                    (
                        x + side * math.cos(math.radians(60 * index)),
                        y + side * math.sin(math.radians(60 * index)),
                    )
                    for index in range(6)
                ]
                hexagons.append(Polygon(points))
            y += height
        column += 1
        x += x_step
    return hexagons


def bezier_ring(coordinates, subdivisions: int):
    """Approximate a closed Catmull-Rom/Bezier curve that passes through every input vertex."""
    points = np.asarray(coordinates[:-1], dtype=float)
    if len(points) < 4:
        return coordinates
    smoothed = []
    for index, start in enumerate(points):
        previous = points[(index - 1) % len(points)]
        end = points[(index + 1) % len(points)]
        following = points[(index + 2) % len(points)]
        start_tangent = 0.5 * (end - previous)
        end_tangent = 0.5 * (following - start)
        for step in range(subdivisions):
            value = step / subdivisions
            value2 = value * value
            value3 = value2 * value
            point = (
                (2 * value3 - 3 * value2 + 1) * start
                + (value3 - 2 * value2 + value) * start_tangent
                + (-2 * value3 + 3 * value2) * end
                + (value3 - value2) * end_tangent
            )
            smoothed.append((float(point[0]), float(point[1])))
    smoothed.append(smoothed[0])
    return smoothed


def bezier_smooth(geometry, subdivisions: int):
    if subdivisions < 1:
        raise ValueError("--bezier-subdivisions must be positive")
    polygons = list(geometry.geoms) if isinstance(geometry, MultiPolygon) else [geometry]
    smoothed = []
    for polygon in polygons:
        exterior = bezier_ring(list(polygon.exterior.coords), subdivisions)
        interiors = [bezier_ring(list(ring.coords), subdivisions) for ring in polygon.interiors]
        smoothed.append(Polygon(exterior, interiors))
    return polygonal(unary_union([polygonal(item) for item in smoothed]))


def chaikin_ring(coordinates, iterations: int, ratio: float):
    points = np.asarray(coordinates[:-1], dtype=float)
    for _ in range(iterations):
        following = np.roll(points, -1, axis=0)
        first = (1 - ratio) * points + ratio * following
        second = ratio * points + (1 - ratio) * following
        points = np.stack((first, second), axis=1).reshape((-1, 2))
    output = [(float(point[0]), float(point[1])) for point in points]
    output.append(output[0])
    return output


def chaikin_smooth(geometry, iterations: int, ratio: float):
    if iterations < 1:
        raise ValueError("--chaikin-iterations must be positive")
    if not 0 < ratio < 0.5:
        raise ValueError("--chaikin-ratio must be between zero and 0.5")
    polygons = list(geometry.geoms) if isinstance(geometry, MultiPolygon) else [geometry]
    smoothed = []
    for polygon in polygons:
        exterior = chaikin_ring(list(polygon.exterior.coords), iterations, ratio)
        interiors = [chaikin_ring(list(ring.coords), iterations, ratio) for ring in polygon.interiors]
        smoothed.append(Polygon(exterior, interiors))
    return polygonal(unary_union([polygonal(item) for item in smoothed]))


def build_tin_boundary(
    ghsl_tif: Path,
    extent,
    inhabited,
    working_crs: str,
    working_to_raster: Transformer,
    raster_to_working: Transformer,
    hex_area: float,
    triangle_perimeter: float,
    hex_selection_method: str,
    smoothing_method: str,
    smooth: float,
    bezier_subdivisions: int,
    chaikin_iterations: int,
    chaikin_ratio: float,
    hex_origin_x: float = 0,
    hex_origin_y: float = 0,
):
    padding = max(500, triangle_perimeter + smooth)
    with rasterio.open(ghsl_tif) as source:
        if str(source.crs) != MOLLWEIDE:
            raise RuntimeError(f"Expected {MOLLWEIDE} GHSL tile, got {source.crs}")
        raster_extent = transform_geometry(extent.buffer(padding), working_to_raster)
        minx, miny, maxx, maxy = raster_extent.bounds
        window = from_bounds(
            minx,
            miny,
            maxx,
            maxy,
            source.transform,
        ).round_offsets().round_lengths()
        values = source.read(1, window=window)
        window_transform = source.window_transform(window)
    built = (values == 1) | (values == 2)
    if not np.any(built):
        raise RuntimeError("No GHSL residential/non-residential pixels found in the pilot extent")

    minx, miny, maxx, maxy = extent.buffer(padding).bounds
    hexagons = generate_flat_hexagons(
        (minx, miny, maxx, maxy),
        hex_area,
        origin_x=hex_origin_x,
        origin_y=hex_origin_y,
    )
    if hex_selection_method == "vector-intersection":
        built_polygons = [
            transform_geometry(shape(geometry), raster_to_working)
            for geometry, value in raster_shapes(
                built.astype("uint8"),
                mask=built,
                transform=window_transform,
                connectivity=8,
            )
            if value == 1
        ]
        built_tree = STRtree(built_polygons)
        selected = [
            geometry
            for geometry in hexagons
            if len(built_tree.query(geometry, predicate="intersects")) > 0
        ]
    elif hex_selection_method == "raster-label":
        if working_crs != MOLLWEIDE:
            raise ValueError("--hex-selection-method raster-label requires the native Mollweide working CRS")
        labelled = rasterize(
            ((mapping(geometry), index + 1) for index, geometry in enumerate(hexagons)),
            out_shape=values.shape,
            transform=window_transform,
            fill=0,
            dtype="int32",
            all_touched=True,
        )
        selected_ids = set(np.unique(labelled[built]).tolist())
        selected_ids.discard(0)
        selected = [hexagons[index - 1] for index in selected_ids]
        built_polygons = []
    else:
        raise ValueError(f"Unsupported hex selection method: {hex_selection_method}")

    vertices = {
        (round(x, 6), round(y, 6))
        for geometry in selected
        for x, y in list(geometry.exterior.coords)[:-1]
    }
    coordinates = np.asarray(sorted(vertices))
    triangles = Delaunay(coordinates)
    retained = []
    for simplex in triangles.simplices:
        points = coordinates[simplex]
        perimeter = (
            np.linalg.norm(points[0] - points[1])
            + np.linalg.norm(points[1] - points[2])
            + np.linalg.norm(points[2] - points[0])
        )
        if perimeter <= triangle_perimeter:
            retained.append(Polygon(points))
    boundary = polygonal(coverage_union_all(retained).intersection(inhabited))
    if smoothing_method == "buffer-close" and smooth:
        boundary = polygonal(boundary.buffer(smooth, quad_segs=4).buffer(-smooth, quad_segs=4))
    elif smoothing_method == "bezier-approximation":
        boundary = bezier_smooth(boundary, bezier_subdivisions)
    elif smoothing_method == "chaikin-approximation":
        boundary = chaikin_smooth(boundary, chaikin_iterations, chaikin_ratio)
    elif smoothing_method != "none":
        raise ValueError(f"Unsupported smoothing method: {smoothing_method}")
    diagnostics = {
        "rasterRows": int(values.shape[0]),
        "rasterColumns": int(values.shape[1]),
        "builtPixelCount": int(np.count_nonzero(built)),
        "builtPolygonCount": len(built_polygons) if hex_selection_method == "vector-intersection" else None,
        "hexagonCount": len(hexagons),
        "selectedHexagonCount": len(selected),
        "tinVertexCount": len(vertices),
        "tinTriangleCount": len(triangles.simplices),
        "retainedTriangleCount": len(retained),
    }
    return boundary, diagnostics


def load_laval_reference(path: Path, include_ids: set[str], transformer: Transformer):
    reader = shapefile.Reader(str(path), encoding="latin1")
    geometries = []
    ids = []
    for item in reader.iterShapeRecords():
        properties = item.record.as_dict()
        da_id = str(properties.get("AD_DA") or "").strip()
        if da_id in include_ids:
            geometries.append(transform_geometry(shape(item.shape.__geo_interface__), transformer))
            ids.append(da_id)
    if set(ids) != include_ids:
        missing = sorted(include_ids - set(ids))
        raise RuntimeError(f"Laval reference is missing {len(missing)} pilot DAs; examples: {missing[:5]}")
    return unary_union(geometries)


def evaluate(candidate, reference) -> dict:
    intersection = candidate.intersection(reference).area
    union = candidate.union(reference).area
    return {
        "candidateAreaKm2": round(candidate.area / 1_000_000, 6),
        "referenceAreaKm2": round(reference.area / 1_000_000, 6),
        "intersectionAreaKm2": round(intersection / 1_000_000, 6),
        "candidatePrecisionPct": round(100 * intersection / candidate.area, 6),
        "referenceRecallPct": round(100 * intersection / reference.area, 6),
        "jaccardPct": round(100 * intersection / union, 6),
    }


def output_validation(da_ids: list[str], geometries: list) -> dict:
    tree = STRtree(geometries)
    pair_count = 0
    overlap_area = 0.0
    for left_index, left in enumerate(geometries):
        for right_index_raw in tree.query(left):
            right_index = int(right_index_raw)
            if right_index <= left_index:
                continue
            area = left.intersection(geometries[right_index]).area
            if area > 0.01:
                pair_count += 1
                overlap_area += area
    return {
        "validFeatureCount": sum(geometry.is_valid for geometry in geometries),
        "emptyFeatureCount": sum(geometry.is_empty for geometry in geometries),
        "uniqueDauidCount": len(set(da_ids)),
        "overlapPairCount": pair_count,
        "overlapAreaM2": round(overlap_area, 6),
    }


def deterministic_gzip(data: bytes) -> bytes:
    output = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=output, compresslevel=9, mtime=0) as stream:
        stream.write(data)
    return output.getvalue()


def main() -> None:
    args = parse_args()
    ghsl_tif = args.ghsl_tif or acquire_ghsl(args.cache_dir)
    if not ghsl_tif.exists():
        raise FileNotFoundError(ghsl_tif)

    wgs_to_working = Transformer.from_crs("EPSG:4326", args.working_crs, always_xy=True)
    working_to_wgs = Transformer.from_crs(args.working_crs, "EPSG:4326", always_xy=True)
    webmercator_to_working = Transformer.from_crs("EPSG:3857", args.working_crs, always_xy=True)
    working_to_raster = Transformer.from_crs(args.working_crs, MOLLWEIDE, always_xy=True)
    raster_to_working = Transformer.from_crs(MOLLWEIDE, args.working_crs, always_xy=True)

    if (args.hex_origin_x is None) != (args.hex_origin_y is None):
        raise ValueError("Specify both --hex-origin-x and --hex-origin-y, or neither")
    if args.hex_origin_x is None:
        hex_origin_x, hex_origin_y = load_grid_origin(args.cma_geojson, wgs_to_working)
        hex_origin_source = str(args.cma_geojson)
    else:
        hex_origin_x, hex_origin_y = args.hex_origin_x, args.hex_origin_y
        hex_origin_source = "command-line override"

    da_ids, db_extent, inhabited, db_count, inhabited_db_count = load_db_geometries(
        args.db_geojson, wgs_to_working
    )
    da_geometries = load_da_geometries(args.da_geojson, wgs_to_working, da_ids)
    candidate, diagnostics = build_tin_boundary(
        ghsl_tif,
        db_extent,
        inhabited,
        args.working_crs,
        working_to_raster,
        raster_to_working,
        args.hex_area,
        args.triangle_perimeter,
        args.hex_selection_method,
        args.smoothing_method,
        args.smooth,
        args.bezier_subdivisions,
        args.chaikin_iterations,
        args.chaikin_ratio,
        hex_origin_x,
        hex_origin_y,
    )
    derived_area_before_simplification = candidate.area
    if args.simplify:
        candidate = valid(candidate.simplify(args.simplify, preserve_topology=True))

    features = []
    output_da_ids = []
    output_geometries = []
    empty_da_ids = []
    for da_id in sorted(da_geometries):
        clipped = polygonal(candidate.intersection(da_geometries[da_id]))
        if clipped.is_empty:
            empty_da_ids.append(da_id)
            continue
        output_da_ids.append(da_id)
        output_geometries.append(clipped)
        wgs_geometry = transform_geometry(clipped, working_to_wgs)
        wgs_geometry = set_precision(wgs_geometry, grid_size=0.000001, mode="valid_output")
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "DAUID": da_id,
                    "boundarySource": "derived-ghsl",
                    "boundaryMethod": "laval-documented-hex-tin-reproduction",
                },
                "geometry": mapping(wgs_geometry),
            }
        )

    collection = {
        "type": "FeatureCollection",
        "name": "Prince George residential ecumene - GHSL reproduction pilot",
        "features": features,
    }
    raw = (json.dumps(collection, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    compressed = deterministic_gzip(raw)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    output_name = "prince-george-city-ghsl-ecumene-pilot.geojson.gz"
    output_path = args.output_dir / output_name
    output_path.write_bytes(compressed)

    report = {
        "dataset": "Prince George residential ecumene GHSL reproduction pilot",
        "status": "experimental",
        "grain": "one feature per 2021 DA with a non-empty derived residential footprint",
        "sources": {
            "ghsl": {
                "product": "GHS_BUILT_C_FUN_E2018_GLOBE_R2022A_54009_10_V1_0",
                "tile": "R3_C10",
                "url": GHSL_TILE_URL,
                "zipSha256": GHSL_ZIP_SHA256,
            },
            "dbGeometryAndPopulation": str(args.db_geojson),
            "daGeometry": str(args.da_geojson),
            "cmaGeometryForGridOrigin": str(args.cma_geojson) if hex_origin_source != "command-line override" else None,
            "lavalReference": str(args.laval_shapefile) if args.laval_shapefile else None,
        },
        "parameters": {
            "workingCrs": args.working_crs,
            "builtClasses": {"1": "residential", "2": "non-residential"},
            "hexagonAreaM2": args.hex_area,
            "hexGridOrigin": {"x": hex_origin_x, "y": hex_origin_y, "source": hex_origin_source},
            "maximumTinTrianglePerimeterM": args.triangle_perimeter,
            "hexSelectionMethod": args.hex_selection_method,
            "smoothingMethod": args.smoothing_method,
            "smoothingBufferM": args.smooth if args.smoothing_method == "buffer-close" else None,
            "bezierSubdivisionsPerSegment": (
                args.bezier_subdivisions if args.smoothing_method == "bezier-approximation" else None
            ),
            "chaikinIterations": (
                args.chaikin_iterations if args.smoothing_method == "chaikin-approximation" else None
            ),
            "chaikinRatio": args.chaikin_ratio if args.smoothing_method == "chaikin-approximation" else None,
            "simplificationToleranceM": args.simplify,
            "unpopulatedDbRule": "exclude DB features whose population is zero",
        },
        "profile": {
            "dbCount": db_count,
            "inhabitedDbCount": inhabited_db_count,
            "inputDaCount": len(da_ids),
            "outputDaCount": len(features),
            "emptyDaCount": len(empty_da_ids),
            "emptyDaIds": empty_da_ids,
            **diagnostics,
            "rawBytes": len(raw),
            "gzipBytes": len(compressed),
            "outputSha256": hashlib.sha256(compressed).hexdigest(),
            "derivedAreaBeforeSimplificationKm2": round(derived_area_before_simplification / 1_000_000, 6),
            "derivedAreaAfterSimplificationKm2": round(candidate.area / 1_000_000, 6),
            "simplificationAreaChangePct": round(
                100 * (candidate.area - derived_area_before_simplification) / derived_area_before_simplification,
                6,
            ),
        },
        "validation": output_validation(output_da_ids, output_geometries),
        "evaluation": None,
        "files": {"boundary": output_name},
        "knownDifferences": [
            "The Laval report does not publish its hex-grid origin or exact working projection; the pilot infers Statistics Canada Lambert and the official CMA lower-left extent from the measured reconstruction.",
            "The Laval report names ArcGIS Smooth Polygon but does not publish the smoothing algorithm or parameters; the pilot uses an explicitly labelled Chaikin approximation.",
            "Statistics Canada geometry and population inputs are fetched independently and may not be byte-identical to Laval's original source archive.",
        ],
    }
    if args.laval_shapefile:
        reference = load_laval_reference(args.laval_shapefile, da_ids, webmercator_to_working)
        report["evaluation"] = evaluate(candidate, reference)

    report_path = args.output_dir / "prince-george-city-ghsl-ecumene-pilot.evaluation.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
