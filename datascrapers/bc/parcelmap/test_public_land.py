import importlib.util
from pathlib import Path
import unittest

import numpy as np
import shapely
from shapely.geometry import Polygon, box

SPEC = importlib.util.spec_from_file_location("public_land", Path(__file__).with_name("build-public-land.py"))
screen = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(screen)


class PublicLandTests(unittest.TestCase):
    def test_ownership_selection_and_unknown_category(self):
        self.assertEqual(screen.public_mask(np.array(["Federal", "First Nations", "Mixed Ownership", "Untitled Provincial", "Private"])).tolist(),
                         [True, False, False, True, False])
        with self.assertRaises(ValueError):
            screen.public_mask(np.array(["New unreviewed category"]))

    def test_overlap_boundary_contact_and_disjoint(self):
        parcels = np.array([box(0, 0, 2, 2), box(2, 0, 3, 1), box(5, 5, 6, 6)], dtype=object)
        exclusion = np.array([box(1, 0, 2, 1)], dtype=object)
        hit, area = screen.intersect_masks(parcels, exclusion)
        self.assertEqual(hit.tolist(), [True, True, False])
        self.assertEqual(area.tolist(), [True, False, False])
        # Screening removes the entire first parcel, without clipping its area.
        self.assertEqual(shapely.area(parcels).tolist(), [4, 1, 1])

    def test_containment_both_directions_and_multiple_masks(self):
        parcels = np.array([box(0, 0, 10, 10), box(3, 3, 4, 4)], dtype=object)
        exclusions = np.array([box(2, 2, 5, 5), box(3, 3, 4, 4)], dtype=object)
        hit, area = screen.intersect_masks(parcels, exclusions)
        self.assertEqual(hit.tolist(), [True, True])
        self.assertEqual(area.tolist(), [True, True])

    def test_invalid_geometry_repaired_only_for_predicates(self):
        original = np.array([Polygon([(0, 0), (2, 2), (0, 2), (2, 0), (0, 0)])], dtype=object)
        repaired, count = screen.predicate_geometries(original)
        self.assertEqual(count, 1)
        self.assertTrue(shapely.is_valid(repaired[0]))
        self.assertFalse(shapely.is_valid(original[0]))

    def test_missing_geometry_fails(self):
        with self.assertRaises(ValueError):
            screen.predicate_geometries(np.array([None], dtype=object))


if __name__ == "__main__":
    unittest.main()
