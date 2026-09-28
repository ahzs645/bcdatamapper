"""Convert a single integer class raster into verified, viewport-loadable polygons.

No class thresholds, colours, simplification, or image tracing are assumed.
Requires numpy and rasterio. Run with --help for the CLI.
"""

import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import shutil
import tempfile

import numpy as np
import rasterio
from affine import Affine
from rasterio.features import rasterize, shapes
from rasterio.windows import Window
from rasterio.warp import transform_geom


def encode_json(value):
    return json.dumps(value, separators=(",", ":"), sort_keys=True, allow_nan=False).encode()


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def polygon_area(rings):
    def area(ring):
        return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:])) / 2)
    return area(rings[0]) - sum(area(ring) for ring in rings[1:])


def geographic_geometry(geometry, source, window):
    geographic = source.crs == rasterio.crs.CRS.from_epsg(4326)
    rings = []
    for ring in geometry["coordinates"]:
        points = []
        for a, b in zip(ring, ring[1:]):
            # Before reprojection, retain every grid-edge vertex. Adjacent
            # polygons then transform identical shared segments identically.
            steps = 1 if geographic else max(1, math.ceil(max(abs(a[0] - b[0]), abs(a[1] - b[1]))))
            for step in range(steps):
                fraction = step / steps
                col = window.col_off + a[0] + (b[0] - a[0]) * fraction
                row = window.row_off + a[1] + (b[1] - a[1]) * fraction
                t = source.transform
                points.append([t.a * col + t.b * row + t.c, t.d * col + t.e * row + t.f])
        points.append(points[0])
        rings.append(points)
    result = {"type": "Polygon", "coordinates": rings}
    if not geographic:
        result = transform_geom(source.crs, "EPSG:4326", result, precision=-1)
    positions = [point for ring in result["coordinates"] for point in ring]
    if any(not math.isfinite(v) for p in positions for v in p):
        raise ValueError("Reprojection produced non-finite coordinates")
    if any(abs(p[0]) > 180 or abs(p[1]) > 85.05112878 for p in positions):
        raise ValueError("Output extends outside the supported Web Mercator extent")
    if any(abs(a[0] - b[0]) > 180 for ring in result["coordinates"] for a, b in zip(ring, ring[1:])):
        raise ValueError("Antimeridian-crossing polygons require a separate splitting step")
    return result


def convert(source_path, output_path, block_size=256, max_classes=256):
    source_path, output_path = Path(source_path), Path(output_path)
    if output_path.exists():
        raise ValueError("Output already exists; choose a new directory")
    if not 16 <= block_size <= 1024 or not 1 <= max_classes <= 65535:
        raise ValueError("block_size must be 16..1024 and max_classes 1..65535")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".raster-polygons-", dir=output_path.parent))
    try:
        with rasterio.open(source_path) as source:
            if source.count != 1 or not np.issubdtype(np.dtype(source.dtypes[0]), np.integer):
                raise ValueError("Expected one integer class band; RGB and continuous rasters need explicit preprocessing")
            if source.crs is None:
                raise ValueError("Source CRS is required")
            if abs(source.transform.determinant) == 0:
                raise ValueError("Source grid transform is singular")
            totals, tiles = {}, []
            features_total = raw_total = gzip_total = valid_total = 0
            for row in range(0, source.height, block_size):
                for col in range(0, source.width, block_size):
                    window = Window(col, row, min(block_size, source.width - col), min(block_size, source.height - row))
                    data = source.read(1, window=window, masked=True)
                    mask = ~np.ma.getmaskarray(data)
                    if not mask.any():
                        continue
                    codes, counts = np.unique(data.data[mask], return_counts=True)
                    if any(abs(int(code)) > 2 ** 53 - 1 for code in codes):
                        raise ValueError("Class code exceeds exact JavaScript integer precision")
                    for code, count in zip(codes, counts, strict=True):
                        totals[int(code)] = totals.get(int(code), 0) + int(count)
                    if len(totals) > max_classes:
                        raise ValueError("Too many classes; classify continuous data explicitly before converting")
                    labels = np.zeros(data.shape, dtype=np.int32)
                    labels[mask] = np.searchsorted(codes, data.data[mask]) + 1
                    native = list(shapes(labels, mask=mask, connectivity=4, transform=Affine.identity()))
                    burned = rasterize(native, out_shape=data.shape, fill=0, transform=Affine.identity(), dtype="int32")
                    if not np.array_equal(burned, labels):
                        raise ValueError(f"Polygon raster round trip failed at {row}/{col}")
                    areas = np.zeros(len(codes), dtype=np.float64)
                    features, positions, published = [], [], []
                    tile_id = f"{row}-{col}"
                    for index, (geometry, label) in enumerate(native):
                        areas[int(label) - 1] += polygon_area(geometry["coordinates"])
                        mapped = geographic_geometry(geometry, source, window)
                        back = mapped if source.crs == rasterio.crs.CRS.from_epsg(4326) else transform_geom("EPSG:4326", source.crs, mapped)
                        published.append((back, int(label)))
                        positions.extend(point for ring in mapped["coordinates"] for point in ring)
                        features.append({"type": "Feature", "id": f"{tile_id}-{index}",
                                         "properties": {"value": int(codes[int(label) - 1])}, "geometry": mapped})
                    if not np.array_equal(areas, counts):
                        raise ValueError(f"Polygon class areas differ from cell counts at {row}/{col}")
                    published_cells = rasterize(published, out_shape=data.shape, fill=0,
                                                transform=source.window_transform(window), dtype="int32")
                    if not np.array_equal(published_cells, labels):
                        raise ValueError(f"Published WGS84 polygons changed cells at {row}/{col}")
                    body = encode_json({"type": "FeatureCollection", "features": features})
                    compressed = gzip.compress(body, compresslevel=9, mtime=0)
                    path = f"tiles/{tile_id}.geojson.gz"
                    (stage / "tiles").mkdir(exist_ok=True)
                    (stage / path).write_bytes(compressed)
                    bounds = [min(p[0] for p in positions), min(p[1] for p in positions),
                              max(p[0] for p in positions), max(p[1] for p in positions)]
                    tiles.append({"id": tile_id, "path": path, "bounds": bounds, "features": len(features),
                                  "bytes": len(compressed), "sha256": hashlib.sha256(compressed).hexdigest()})
                    features_total += len(features)
                    raw_total += len(body)
                    gzip_total += len(compressed)
                    valid_total += int(mask.sum())
            if not tiles:
                raise ValueError("Source has no valid cells")
            manifest = {"format": "categorical-raster-polygons-v1", "source": {
                "name": source_path.name, "sha256": sha256(source_path), "bytes": source_path.stat().st_size,
                "crs": source.crs.to_string(), "transform": list(source.transform)[:6],
                "width": source.width, "height": source.height, "nodata": source.nodata},
                "outputCrs": "EPSG:4326", "blockSize": block_size, "simplification": None,
                "classCounts": {str(k): v for k, v in sorted(totals.items())},
                "validation": {"rasterRoundTrip": True, "publishedGeometryRoundTrip": True, "classAreaEqualsCellCount": True,
                               "checkedCells": source.width * source.height, "validCells": valid_total},
                "features": features_total, "rawBytes": raw_total, "gzipBytes": gzip_total, "tiles": tiles}
            (stage / "manifest.json").write_bytes(encode_json(manifest))
        stage.rename(output_path)
        return manifest
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path, help="New output directory")
    parser.add_argument("--block-size", type=int, default=256)
    parser.add_argument("--max-classes", type=int, default=256)
    args = parser.parse_args()
    result = convert(args.input, args.output, args.block_size, args.max_classes)
    print(json.dumps({k: v for k, v in result.items() if k != "tiles"} | {"tiles": len(result["tiles"])}, indent=2))


if __name__ == "__main__":
    main()
