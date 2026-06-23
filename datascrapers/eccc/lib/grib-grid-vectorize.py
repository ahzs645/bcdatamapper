#!/usr/bin/env python3
import argparse
import gzip
import json
import math
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import rasterio
import requests
from rasterio.features import shapes
from rasterio.warp import transform_geom


PM25_CLASSES = [
    (0, "#21c5f4", "0-10", 0),
    (1, "#1899c9", "10-20", 10),
    (2, "#0d6796", "20-30", 20),
    (3, "#fefc37", "30-40", 30),
    (4, "#fecb2e", "40-50", 40),
    (5, "#fd993f", "50-60", 50),
    (6, "#fc6769", "60-70", 60),
    (7, "#fe3b3b", "70-80", 70),
    (8, "#fe0101", "80-90", 80),
    (9, "#ca0713", "90-100", 90),
    (10, "#650205", "100+", 100),
]


def download_to_temp(url):
    response = requests.get(url, timeout=120)
    response.raise_for_status()
    suffix = Path(urlparse(url).path).suffix or ".grib2"
    temp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    with temp:
        temp.write(response.content)
    return Path(temp.name), len(response.content)


def input_path(source):
    if source.startswith("http://") or source.startswith("https://"):
        return download_to_temp(source)
    path = Path(source)
    return path, path.stat().st_size


def class_metadata(cls):
    _, color, label, lower = PM25_CLASSES[cls]
    upper = None if cls == len(PM25_CLASSES) - 1 else PM25_CLASSES[cls + 1][3]
    return color, label, lower, upper


def classify(values, nodata, scale, min_visible):
    scaled = values.astype("float64") * scale
    mask = np.isfinite(scaled)
    if nodata is not None and math.isfinite(nodata):
        mask &= values != nodata
    if min_visible is not None:
        mask &= scaled >= min_visible

    classes = np.full(values.shape, -1, dtype=np.int16)
    for cls, _, _, lower in PM25_CLASSES:
        classes[(scaled >= lower) & mask] = cls
    return classes, mask


def densify_line(coords, max_segment_length):
    if max_segment_length <= 0 or len(coords) < 2:
        return coords

    densified = [coords[0]]
    for start, end in zip(coords, coords[1:]):
        start_x, start_y = start[:2]
        end_x, end_y = end[:2]
        distance = max(abs(end_x - start_x), abs(end_y - start_y))
        segment_count = max(1, math.ceil(distance / max_segment_length))

        for index in range(1, segment_count + 1):
            fraction = index / segment_count
            densified.append(
                [
                    start_x + (end_x - start_x) * fraction,
                    start_y + (end_y - start_y) * fraction,
                ]
            )

    return densified


def densify_polygon_rings(rings, max_segment_length):
    return [densify_line(ring, max_segment_length) for ring in rings]


def densify_geometry(geometry, max_segment_length):
    geometry_type = geometry["type"]
    coordinates = geometry["coordinates"]
    if geometry_type == "Polygon":
        return {**geometry, "coordinates": densify_polygon_rings(coordinates, max_segment_length)}
    if geometry_type == "MultiPolygon":
        return {
            **geometry,
            "coordinates": [densify_polygon_rings(polygon, max_segment_length) for polygon in coordinates],
        }
    return geometry


def vectorize(args):
    source_path, source_bytes = input_path(args.input)
    try:
        with rasterio.open(source_path) as dataset:
            values = dataset.read(1)
            classes, mask = classify(values, dataset.nodata, args.scale, args.min_visible)
            class_counts = np.bincount(classes[classes >= 0].ravel(), minlength=len(PM25_CLASSES)).tolist()

            features = []
            for geometry, cls_value in shapes(classes, mask=mask, transform=dataset.transform):
                cls = int(cls_value)
                if cls < 0:
                    continue
                densified = densify_geometry(geometry, args.max_segment_degrees)
                transformed = transform_geom(dataset.crs, "EPSG:4326", densified, precision=args.precision)
                color, label, lower, upper = class_metadata(cls)
                features.append(
                    {
                        "type": "Feature",
                        "properties": {
                            "c": cls,
                            "label": label,
                            "pm25_min": lower,
                            "pm25_max": upper,
                            "fill": color,
                        },
                        "geometry": transformed,
                    }
                )

            tags = dataset.tags(1)
            return {
                "type": "FeatureCollection",
                "properties": {
                    "source": args.input,
                    "generatedAt": datetime.now(timezone.utc).isoformat(),
                    "driver": dataset.driver,
                    "width": dataset.width,
                    "height": dataset.height,
                    "sourceBytes": source_bytes,
                    "crs": dataset.crs.to_wkt() if dataset.crs else None,
                    "transform": list(dataset.transform)[:6],
                    "bounds": {
                        "left": dataset.bounds.left,
                        "bottom": dataset.bounds.bottom,
                        "right": dataset.bounds.right,
                        "top": dataset.bounds.top,
                    },
                    "scale": args.scale,
                    "minVisible": args.min_visible,
                    "maxSegmentDegrees": args.max_segment_degrees,
                    "classCounts": class_counts,
                    "classification": "PM2.5_0to100ugm3_Dis lower-bound classes derived from native RAQDPS GRIB2 rotated-lat-lon grid; values below minVisible are masked to match WMS transparency.",
                    "grib": {
                        "unit": tags.get("GRIB_UNIT"),
                        "refTime": tags.get("GRIB_REF_TIME"),
                        "validTime": tags.get("GRIB_VALID_TIME"),
                        "forecastSeconds": tags.get("GRIB_FORECAST_SECONDS"),
                        "ids": tags.get("GRIB_IDS"),
                    },
                },
                "features": features,
            }
    finally:
        if args.input.startswith("http://") or args.input.startswith("https://"):
            source_path.unlink(missing_ok=True)


def write_gzip_json(path, payload):
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wb", compresslevel=9) as output:
        output.write(body)
    return len(body), path.stat().st_size


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Local GRIB2 path or HTTPS URL")
    parser.add_argument("--output", required=True)
    parser.add_argument("--scale", type=float, default=1_000_000_000)
    parser.add_argument("--min-visible", type=float, default=1.0)
    parser.add_argument("--max-segment-degrees", type=float, default=0.09)
    parser.add_argument("--precision", type=int, default=6)
    args = parser.parse_args()

    collection = vectorize(args)
    raw_bytes, gzip_bytes = write_gzip_json(Path(args.output), collection)
    print(
        json.dumps(
            {
                "output": args.output,
                "features": len(collection["features"]),
                "rawBytes": raw_bytes,
                "gzipBytes": gzip_bytes,
                "sourceBytes": collection["properties"]["sourceBytes"],
                "width": collection["properties"]["width"],
                "height": collection["properties"]["height"],
                "classCounts": collection["properties"]["classCounts"],
            }
        )
    )


if __name__ == "__main__":
    main()
