import unittest
import tempfile
from pathlib import Path
import numpy as np
import rasterio
from rasterio.transform import from_origin
from categorical_raster import convert
from categorical_overviews import sampled_grid, build


class OverviewTests(unittest.TestCase):
    def test_odd_extent_mask_and_classes_are_preserved_at_sample_locations(self):
        data = np.ma.array(np.arange(35).reshape(5, 7), mask=False)
        data.mask[1, 1] = True
        sampled, transform = sampled_grid(data, 2)
        self.assertEqual(transform * (sampled.shape[1], sampled.shape[0]), (7, 5))
        for r in range(sampled.shape[0]):
            for c in range(sampled.shape[1]):
                x, y = transform * (c + 0.5, r + 0.5)
                self.assertEqual(sampled.data[r, c], data.data[int(y), int(x)])
                self.assertEqual(sampled.mask[r, c], data.mask[int(y), int(x)])

    def test_zero_is_valid_and_missing_samples_stay_missing(self):
        data = np.ma.array([[0, 0, 20, 20]] * 4, mask=False)
        data.mask[1, 3] = True
        sampled, _ = sampled_grid(data, 2)
        self.assertEqual(sampled[0, 0], 0)
        self.assertTrue(sampled.mask[0, 1])

    def test_pipeline_keeps_source_bounds_and_is_deterministic(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "source.tif"
            cells = np.ones((33, 35), dtype="uint8")
            cells[8:20, 8:20] = 2
            cells[0, 0] = 0
            with rasterio.open(
                path,
                "w",
                driver="GTiff",
                count=1,
                width=35,
                height=33,
                dtype="uint8",
                crs="EPSG:4326",
                nodata=0,
                transform=from_origin(-126, 55, 0.01, 0.01),
            ) as dest:
                dest.write(cells, 1)
            convert(path, root / "full")
            first = build(path, root / "full/manifest.json", root / "a", [(2, 0)])
            second = build(path, root / "full/manifest.json", root / "b", [(2, 0)])
            self.assertEqual(first, second)
            self.assertEqual(
                (root / "a/factor-2/manifest.json").read_bytes(),
                (root / "b/factor-2/manifest.json").read_bytes(),
            )
            with (
                rasterio.open(path) as source,
                rasterio.open(root / "a/grid-2.tif") as overview,
            ):
                np.testing.assert_allclose(source.bounds, overview.bounds)
            # A different raster cannot silently inherit this full-detail layer.
            with rasterio.open(path, "r+") as changed:
                changed.write(np.full_like(cells, 2), 1)
            with self.assertRaisesRegex(ValueError, "exact raster"):
                build(path, root / "full/manifest.json", root / "c", [(2, 0)])


if __name__ == "__main__":
    unittest.main()
