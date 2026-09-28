import unittest
import numpy as np
from grid_tile_votes import accumulate, resolve, axis_cells


class VotesTest(unittest.TestCase):
    def test_votes_combine_across_tile_seams(self):
        counts = np.zeros((5, 2, 3), dtype="uint16")
        # Cell 1 straddles two source tiles: each side alone lacks the four required samples.
        accumulate(
            counts, np.array([[10, 20], [10, 20]]), np.array([0, 0]), np.array([0, 1])
        )
        accumulate(
            counts, np.array([[20, 30], [20, 30]]), np.array([0, 0]), np.array([1, 2])
        )
        result = resolve(counts, np.full((2, 3), 4))
        np.testing.assert_array_equal(result, [[99, 20, 99], [0, 0, 0]])
        self.assertEqual(counts[1, 0, 1], 4)

    def test_conflicting_and_unclassified_samples_stay_uncertain(self):
        counts = np.zeros((5, 1, 3), dtype="uint16")
        counts[0, 0, 0] = 4
        counts[1, 0, 0] = 4
        counts[0, 0, 1] = 4
        counts[4, 0, 1] = 6
        counts[2, 0, 2] = 10
        np.testing.assert_array_equal(
            resolve(counts, np.array([[8, 10, 10]])), [[99, 99, 30]]
        )

    def test_axis_only_includes_cell_interiors_inside_extent(self):
        pixels, cells = axis_cells(12, 629, "x", -124.716, 1 / 360, 30)
        longitude = (629 * 256 + pixels + 0.5) / (2**12 * 256) * 360 - 180
        position = (longitude + 124.716) / (1 / 360)
        self.assertTrue(np.all((position - cells >= 0.2) & (position - cells <= 0.8)))
        self.assertTrue(np.all((cells >= 0) & (cells < 30)))


if __name__ == "__main__":
    unittest.main()
