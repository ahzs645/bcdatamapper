#!/usr/bin/env python3
"""Inspect ClimateData.ca NetCDF/HDF5 downloads and build the shared BC cell mask."""

import argparse
import hashlib
import json
from pathlib import Path

import h5py
import numpy as np
from matplotlib.path import Path as GeometryPath


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
DEFAULT_CACHE = SCRIPT_DIRECTORY / "cache"
DEFAULT_BOUNDARY = (
    SCRIPT_DIRECTORY.parent.parent
    / "bc"
    / "boundaries"
    / "output"
    / "BC"
    / "regional_districts.geojson"
)


def parse_arguments():
    parser = argparse.ArgumentParser(
        description="Analyze the downloaded CanDCS-M6 files and create a shared BC grid mask."
    )
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--boundary", type=Path, default=DEFAULT_BOUNDARY)
    parser.add_argument("--analysis", type=Path)
    parser.add_argument("--indices", type=Path)
    return parser.parse_args()


def digest(array):
    return hashlib.sha256(np.ascontiguousarray(array).tobytes()).hexdigest()


def polygon_mask(points, rings):
    if not rings:
        return np.zeros(len(points), dtype=bool)
    selected = GeometryPath(np.asarray(rings[0])).contains_points(points, radius=1e-10)
    for hole in rings[1:]:
        selected &= ~GeometryPath(np.asarray(hole)).contains_points(
            points, radius=1e-10
        )
    return selected


def geometry_mask(points, geometry):
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates", [])
    if geometry_type == "Polygon":
        return polygon_mask(points, coordinates)
    if geometry_type == "MultiPolygon":
        selected = np.zeros(len(points), dtype=bool)
        for polygon in coordinates:
            selected |= polygon_mask(points, polygon)
        return selected
    return np.zeros(len(points), dtype=bool)


def data_names(source):
    return sorted(
        name
        for name, value in source.items()
        if isinstance(value, h5py.Dataset) and value.ndim == 3
    )


def main():
    arguments = parse_arguments()
    cache = arguments.cache_dir.resolve()
    manifest_file = (arguments.manifest or cache / "download-manifest.json").resolve()
    analysis_file = (arguments.analysis or cache / "download-analysis.json").resolve()
    indices_file = (arguments.indices or cache / "bc-grid-flat-indices.npy").resolve()
    manifest = json.loads(manifest_file.read_text())
    files = [
        cache / result["file"]
        for result in manifest["results"]
        if result["status"] != "failed"
    ]
    if not files:
        raise RuntimeError(f"No successful source files in {manifest_file}")

    records = []
    coordinate_sets = {}
    reference_lat = reference_lon = reference_time = None

    for file in files:
        with h5py.File(file, "r") as source:
            lat = source["lat"][:]
            lon = source["lon"][:]
            time = source["time"][:]
            coordinate_key = f"{digest(lat)}:{digest(lon)}:{digest(time)}"
            coordinate_sets.setdefault(coordinate_key, []).append(file.stem)
            if reference_lat is None:
                reference_lat, reference_lon, reference_time = lat, lon, time

            names = data_names(source)
            absolute_names = [name for name in names if "_delta_" not in name]
            delta_names = [name for name in names if "_delta_" in name]
            all_storage = sum(source[name].id.get_storage_size() for name in names)
            absolute_storage = sum(
                source[name].id.get_storage_size() for name in absolute_names
            )
            delta_storage = sum(
                source[name].id.get_storage_size() for name in delta_names
            )
            coordinate_storage = sum(
                source[name].id.get_storage_size() for name in ("lat", "lon", "time")
            )
            first = source[absolute_names[0]][0]

            records.append(
                {
                    "variable": file.stem,
                    "file": str(file.relative_to(cache)),
                    "bytes": file.stat().st_size,
                    "shape": list(source[names[0]].shape),
                    "dtype": str(source[names[0]].dtype),
                    "dataArrays": len(names),
                    "absoluteArrays": len(absolute_names),
                    "deltaArrays": len(delta_names),
                    "storedDataBytes": all_storage,
                    "storedAbsoluteBytes": absolute_storage,
                    "storedDeltaBytes": delta_storage,
                    "storedCoordinateBytes": coordinate_storage,
                    "otherBytes": file.stat().st_size
                    - all_storage
                    - coordinate_storage,
                    "finiteGridPositionsFirstBand": int(np.isfinite(first).sum()),
                    "coordinateKey": coordinate_key,
                }
            )

    lon_grid, lat_grid = np.meshgrid(reference_lon, reference_lat)
    points = np.column_stack([lon_grid.ravel(), lat_grid.ravel()])
    boundaries = json.loads(arguments.boundary.resolve().read_text())
    bc_mask = np.zeros(len(points), dtype=bool)
    for feature in boundaries["features"]:
        bc_mask |= geometry_mask(points, feature["geometry"])

    with h5py.File(files[0], "r") as source:
        first_absolute = next(
            name for name in data_names(source) if "_delta_" not in name
        )
        valid_mask = np.isfinite(source[first_absolute][0]).ravel()

    shared_mask = bc_mask & valid_mask
    indices_file.parent.mkdir(parents=True, exist_ok=True)
    np.save(indices_file, np.flatnonzero(shared_mask).astype(np.uint32))

    summary = {
        "schemaVersion": 1,
        "sourceFiles": len(records),
        "sourceBytes": sum(record["bytes"] for record in records),
        "coordinateSetCount": len(coordinate_sets),
        "coordinateSets": [
            {"key": key, "variables": variables}
            for key, variables in coordinate_sets.items()
        ],
        "grid": {
            "latitudeCount": int(len(reference_lat)),
            "longitudeCount": int(len(reference_lon)),
            "rectanglePositions": int(len(points)),
            "validRectanglePositions": int(valid_mask.sum()),
            "bcBoundaryPositions": int(bc_mask.sum()),
            "sharedBcValidPositions": int(shared_mask.sum()),
        },
        "timeCount": int(len(reference_time)),
        "dataArrays": sum(record["dataArrays"] for record in records),
        "absoluteArrays": sum(record["absoluteArrays"] for record in records),
        "deltaArrays": sum(record["deltaArrays"] for record in records),
        "storedDataBytes": sum(record["storedDataBytes"] for record in records),
        "storedAbsoluteBytes": sum(
            record["storedAbsoluteBytes"] for record in records
        ),
        "storedDeltaBytes": sum(record["storedDeltaBytes"] for record in records),
        "storedCoordinateBytes": sum(
            record["storedCoordinateBytes"] for record in records
        ),
        "otherBytes": sum(record["otherBytes"] for record in records),
        "boundaryFile": str(arguments.boundary.resolve()),
        "indicesFile": str(indices_file),
        "records": records,
    }
    analysis_file.parent.mkdir(parents=True, exist_ok=True)
    analysis_file.write_text(json.dumps(summary, indent=2) + "\n")
    concise = {
        key: value
        for key, value in summary.items()
        if key not in {"records", "coordinateSets"}
    }
    print(json.dumps(concise, indent=2))


if __name__ == "__main__":
    main()
