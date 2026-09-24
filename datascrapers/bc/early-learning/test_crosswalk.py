import unittest
try:
    from shapely.geometry import box
    from crosswalk import compare
except ImportError:
    compare = None


@unittest.skipIf(compare is None, 'crosswalk.py needs requirements-crosswalk.txt (run through uv)')
class CrosswalkTests(unittest.TestCase):
    def test_split_area_is_never_matched_to_its_subdivisions(self):
        publisher = {'CHSA_2210': box(0, 0, 2, 1), 'CHSA_1110': box(2, 0, 3, 1)}
        current = {'CHSA_2211': box(0, 0, 1, 1), 'CHSA_2212': box(1, 0, 2, 1), 'CHSA_1110': box(2, 0, 3, 1)}
        result = compare(publisher, current)
        self.assertEqual(result['regions']['CHSA_1110'], {'status': 'same_area', 'iou': 1.0})
        self.assertEqual(result['regions']['CHSA_2210']['status'], 'not_in_reference')
        self.assertEqual([o['id'] for o in result['regions']['CHSA_2210']['overlaps']], ['CHSA_2211', 'CHSA_2212'])
        self.assertEqual(sorted(result['referenceOnly']), ['CHSA_2211', 'CHSA_2212'])

    def test_reused_code_for_a_different_place_is_changed(self):
        result = compare({'CHSA_2222': box(0, 0, 1, 1), 'CHSA_2223': box(1, 0, 2, 1)},
                         {'CHSA_2222': box(1, 0, 2, 1), 'CHSA_2223': box(0, 0, 1, 1)})
        self.assertEqual(result['regions']['CHSA_2222']['status'], 'changed')
        self.assertEqual(result['regions']['CHSA_2222']['iou'], 0)

    def test_coastline_drawn_over_water_is_not_a_boundary_change(self):
        # The publisher's polygon extends over water the official layer omits.
        result = compare({'CHSA_3114': box(0, 0, 4, 1), 'CHSA_3115': box(0, 1, 1, 2)},
                         {'CHSA_3114': box(0, 0, 1, 1), 'CHSA_3115': box(0, 1, 1, 2)})
        self.assertEqual(result['regions']['CHSA_3114']['status'], 'same_area')


if __name__ == '__main__': unittest.main()
