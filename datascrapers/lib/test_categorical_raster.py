import gzip
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import rasterio
from affine import Affine
from rasterio.enums import MergeAlg
from rasterio.features import rasterize
from rasterio.warp import transform_geom

from categorical_raster import convert


class ConversionTest(unittest.TestCase):
    def write(self, root, data, crs="EPSG:4326", transform=None, count=1):
        path = root / "source.tif"
        with rasterio.open(path, "w", driver="GTiff", width=data.shape[1], height=data.shape[0],
                           count=count, dtype=data.dtype, nodata=-999 if data.dtype.kind == "i" else None,
                           crs=crs, transform=transform or Affine(0.001, 0, -123, 0, -0.001, 54)) as dst:
            for band in range(1, count + 1):
                dst.write(data, band)
        return path

    def assert_published_roundtrip(self, path, output):
        manifest = json.loads((output / "manifest.json").read_text())
        features = [f for tile in manifest["tiles"]
                    for f in json.loads(gzip.decompress((output / tile["path"]).read_bytes()))["features"]]
        with rasterio.open(path) as source:
            geometries = [(transform_geom("EPSG:4326", source.crs, f["geometry"]), f["properties"]["value"])
                          for f in features]
            burned = rasterize(geometries, out_shape=source.shape, transform=source.transform, fill=-999, dtype="int32")
            np.testing.assert_array_equal(burned, source.read(1))
            coverage = rasterize([(g, 1) for g, _ in geometries], out_shape=source.shape,
                                 transform=source.transform, merge_alg=MergeAlg.add, dtype="int32")
            np.testing.assert_array_equal(coverage, source.read_masks(1) > 0)
        return manifest

    def test_holes_diagonals_seams_zero_and_determinism(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = np.zeros((20, 35), dtype=np.int16)
            data[2:18, 3:32] = 42
            data[5:8, 5:8] = -999
            data[10, 15] = data[11, 16] = -7
            path = self.write(root, data)
            first = convert(path, root / "first", block_size=16)
            convert(path, root / "second", block_size=16)
            self.assert_published_roundtrip(path, root / "first")
            self.assertEqual(first["classCounts"], {"-7": 2, "0": 236, "42": 453})
            for file in (root / "first").rglob("*"):
                if file.is_file():
                    self.assertEqual(file.read_bytes(), (root / "second" / file.relative_to(root / "first")).read_bytes())

    def test_projected_rotated_grid(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = np.full((20, 35), 12, dtype=np.int16)
            data[:, 17:] = 21
            data[5:9, 5:9] = -999
            path = self.write(root, data, "EPSG:3005", Affine(100, 10, 1000000, 5, -100, 1000000))
            convert(path, root / "out", block_size=16)
            self.assert_published_roundtrip(path, root / "out")

    def test_rejects_rgb_continuous_and_excess_classes(self):
        for dtype, count, max_classes in [("uint8", 3, 256), ("float32", 1, 256), ("int16", 1, 2)]:
            with self.subTest(dtype=dtype, count=count), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path = self.write(root, np.arange(16).reshape(4, 4).astype(dtype), count=count)
                with self.assertRaises(ValueError):
                    convert(path, root / "out", max_classes=max_classes)
                self.assertFalse((root / "out").exists())


if __name__ == "__main__":
    unittest.main()
