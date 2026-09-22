import importlib.util
from pathlib import Path
import unittest

import shapely
from shapely.geometry import box

SPEC = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('audit-public-land.py'))
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


class AuditTests(unittest.TestCase):
    def test_pid_formats_do_not_change_join_identity(self):
        self.assertEqual(audit.pid('001-234-567'), audit.pid(1234567.0))
        self.assertEqual(audit.pid('001234567'), '001234567')
        self.assertIsNone(audit.pid(None))
        self.assertIsNone(audit.pid(0))
        with self.assertRaises(ValueError):
            audit.pid(1234567.5)

    def test_overlapping_exclusion_masks_are_not_double_counted(self):
        masks = {
            'a': shapely.STRtree([box(0, 0, 2, 2)]),
            'b': shapely.STRtree([box(1, 0, 3, 2)]),
        }
        area, fraction, names = audit.overlap_detail(box(0, 0, 4, 2), masks)
        self.assertEqual(area, 6)
        self.assertEqual(fraction, .75)
        self.assertEqual(names, 'a;b')

    def test_northern_rockies_alias_does_not_merge_north_coast(self):
        self.assertEqual(audit.region('NRRM'), audit.region('Northern Rockies Regional Municipality'))
        self.assertNotEqual(audit.region('Northern Rockies'), audit.region('North Coast Regional District'))


if __name__ == '__main__':
    unittest.main()
