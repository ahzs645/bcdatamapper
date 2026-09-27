import gzip
import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('laep', Path(__file__).with_name('sync-laep.py'))
laep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(laep)


class PublishedLaepTests(unittest.TestCase):
    def test_missing_values_are_not_zero(self):
        self.assertEqual(laep.value('F'), {'value': None, 'status': 'suppressed'})
        self.assertEqual(laep.value('-'), {'value': None, 'status': 'not-reported'})
        self.assertEqual(laep.value('0.0%'), {'value': 0, 'status': 'reported'})
        self.assertEqual(laep.value('1,234'), {'value': 1234, 'status': 'reported'})
        with self.assertRaises(ValueError):
            laep.value('unexpected-token')

    def test_keys_join_by_geography_name_year_not_csv_order(self):
        stats = laep.table('descriptive-stats')
        dependencies = laep.table('income-dependencies')
        self.assertEqual(set(stats), set(dependencies))
        self.assertEqual(dependencies[('EDA', 'Prince George', 2020)]['Forestry Total'], '10.5%')
        self.assertEqual(dependencies[('RD', 'Fraser-Fort George', 2020)]['Forestry Total'], '12.4%')

    def test_regional_geometry_joins_completely_and_uniquely(self):
        data = json.loads((laep.OUTPUT / 'regional-districts.json').read_text())
        boundaries = json.loads(laep.BOUNDARIES.read_text())
        self.assertEqual({r['id'] for r in data['records']},
                         {f['properties']['id'] for f in boundaries['features']})
        self.assertEqual(len(data['records']), 29)
        ff = next(r for r in data['records'] if r['id'] == '5953')
        self.assertEqual(ff['dependency_change_pp'], round(ff['forestry_dependency_2020'] - ff['forestry_dependency_2015'], 1))

    def test_reference_and_census_years_remain_distinct(self):
        data = json.loads(gzip.decompress((laep.OUTPUT / 'area-indicators.json.gz').read_bytes()))
        self.assertEqual(len(data['records']), 399)
        self.assertTrue(all(r['censusYear'] == r['referenceYear'] + 1 for r in data['records']))
        self.assertTrue(any(m['status'] == 'suppressed' and m['value'] is None
                            for r in data['records'] for m in r['metrics'].values()))

    def test_bins_have_unambiguous_edges_and_null_fallback(self):
        self.assertEqual(laep.band(None, [2, 5], ['low', 'mid', 'high']), 'Not reported')
        self.assertEqual(laep.band(2, [2, 5], ['low', 'mid', 'high']), 'mid')
        self.assertEqual(laep.band(5, [2, 5], ['low', 'mid', 'high']), 'high')

    def test_outputs_rebuild_deterministically(self):
        paths = sorted(laep.OUTPUT.iterdir())
        before = {p.name: p.read_bytes() for p in paths}
        laep.build()
        self.assertEqual(before, {p.name: p.read_bytes() for p in paths})


if __name__ == '__main__':
    unittest.main()
