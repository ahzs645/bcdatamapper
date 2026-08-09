#!/usr/bin/env python3
"""Inspect Humidex/SPEI files and create one shared BC cell mask per grid family."""

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path

import h5py
import numpy as np
from matplotlib.path import Path as GeometryPath


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
DEFAULT_CACHE = SCRIPT_DIRECTORY / "cache" / "separate-grids"
DEFAULT_BOUNDARY = (
    SCRIPT_DIRECTORY.parent.parent
    / "bc"
    / "boundaries"
    / "output"
    / "BC"
    / "regional_districts.geojson"
)


def parse_arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--boundary", type=Path, default=DEFAULT_BOUNDARY)
    parser.add_argument("--analysis", type=Path)
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
    if geometry.get("type") == "Polygon":
        return polygon_mask(points, geometry.get("coordinates", []))
    if geometry.get("type") == "MultiPolygon":
        selected = np.zeros(len(points), dtype=bool)
        for polygon in geometry.get("coordinates", []):
            selected |= polygon_mask(points, polygon)
        return selected
    return np.zeros(len(points), dtype=bool)


def climate_data_names(source):
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
    manifest = json.loads(manifest_file.read_text())
    successful = [
        result for result in manifest["results"] if result["status"] != "failed"
    ]
    if not successful:
        raise RuntimeError(f"No successful files in {manifest_file}")

    boundary = json.loads(arguments.boundary.resolve().read_text())
    family_records = defaultdict(list)
    family_references = {}

    for result in successful:
        file = cache / result["file"]
        with h5py.File(file, "r") as source:
            lat = source["lat"][:]
            lon = source["lon"][:]
            time = source["time"][:]
            grid_key = f"{digest(lat)}:{digest(lon)}"
            names = climate_data_names(source)
            absolute = [name for name in names if "_delta_" not in name]
            deltas = [name for name in names if "_delta_" in name]
            if result["family"] not in family_references:
                family_references[result["family"]] = {
                    "lat": lat,
                    "lon": lon,
                    "valid": np.isfinite(source[absolute[0]][0]).ravel(),
                    "gridKey": grid_key,
                }
            family_records[result["family"]].append(
                {
                    "file": result["file"],
                    "variable": result["variable"],
                    "datasetType": result["datasetType"],
                    "month": result["month"],
                    "bytes": file.stat().st_size,
                    "gridKey": grid_key,
                    "timeKey": digest(time),
                    "timeCount": len(time),
                    "dataArrays": len(names),
                    "absoluteArrays": len(absolute),
                    "deltaArrays": len(deltas),
                    "storedDataBytes": sum(
                        source[name].id.get_storage_size() for name in names
                    ),
                    "storedAbsoluteBytes": sum(
                        source[name].id.get_storage_size() for name in absolute
                    ),
                    "storedDeltaBytes": sum(
                        source[name].id.get_storage_size() for name in deltas
                    ),
                }
            )

    families = {}
    for family, records in sorted(family_records.items()):
        reference = family_references[family]
        grid_keys = sorted({record["gridKey"] for record in records})
        if len(grid_keys) != 1:
            raise RuntimeError(f"{family} unexpectedly contains {len(grid_keys)} grids")
        lon_grid, lat_grid = np.meshgrid(reference["lon"], reference["lat"])
        points = np.column_stack([lon_grid.ravel(), lat_grid.ravel()])
        bc_mask = np.zeros(len(points), dtype=bool)
        for feature in boundary["features"]:
            bc_mask |= geometry_mask(points, feature["geometry"])
        shared_mask = bc_mask & reference["valid"]
        indices_file = cache / f"{family}-grid-flat-indices.npy"
        np.save(indices_file, np.flatnonzero(shared_mask).astype(np.uint32))
        families[family] = {
            "sourceFiles": len(records),
            "sourceBytes": sum(record["bytes"] for record in records),
            "gridKey": grid_keys[0],
            "grid": {
                "latitudeCount": len(reference["lat"]),
                "longitudeCount": len(reference["lon"]),
                "rectanglePositions": len(points),
                "validRectanglePositions": int(reference["valid"].sum()),
                "bcBoundaryPositions": int(bc_mask.sum()),
                "sharedBcValidPositions": int(shared_mask.sum()),
            },
            "timeAxisCount": len({record["timeKey"] for record in records}),
            "dataArrays": sum(record["dataArrays"] for record in records),
            "absoluteArrays": sum(record["absoluteArrays"] for record in records),
            "deltaArrays": sum(record["deltaArrays"] for record in records),
            "storedDataBytes": sum(record["storedDataBytes"] for record in records),
            "storedAbsoluteBytes": sum(
                record["storedAbsoluteBytes"] for record in records
            ),
            "storedDeltaBytes": sum(record["storedDeltaBytes"] for record in records),
            "indicesFile": str(indices_file),
            "records": records,
        }

    summary = {
        "schemaVersion": 1,
        "sourceFiles": len(successful),
        "sourceBytes": sum(result["bytes"] for result in successful),
        "boundaryFile": str(arguments.boundary.resolve()),
        "families": families,
    }
    analysis_file.write_text(json.dumps(summary, indent=2) + "\n")
    concise = {
        **{key: value for key, value in summary.items() if key != "families"},
        "families": {
            family: {key: value for key, value in details.items() if key != "records"}
            for family, details in families.items()
        },
    }
    print(json.dumps(concise, indent=2))


if __name__ == "__main__":
    main()
