import copy
import unittest
from build import normalize


def source():
    return {'type': 'FeatureCollection', 'features': [
        {'id': 'volatile-wfs-id', 'geometry': {'type': 'Point', 'coordinates': [-122.7, 53.9]},
         'properties': {'SITE_ID': 42, 'COMMON_NAME': '  Example  ', 'OBJECTID': 999}}
    ]}


class BuildTests(unittest.TestCase):
    def test_normalizes_stable_identity_without_inventing_status(self):
        a, b = source(), source()
        b['features'][0]['id'] = 'another-volatile-id'
        b['features'][0]['properties']['OBJECTID'] = 1000
        self.assertEqual(normalize(a), normalize(b))
        feature = normalize(a)['features'][0]
        self.assertEqual(feature['id'], 42)
        self.assertEqual(feature['properties']['name'], 'Example')
        self.assertIsNone(feature['properties']['description'])
        self.assertNotIn('status', feature['properties'])
        self.assertEqual(feature['geometry'], a['features'][0]['geometry'])

    def test_rejects_duplicate_registry_ids(self):
        data = source()
        data['features'].append(copy.deepcopy(data['features'][0]))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            normalize(data)

    def test_rejects_invalid_geometry(self):
        for geometry in [None, {'type': 'Polygon', 'coordinates': []},
                         {'type': 'Point', 'coordinates': [-122, float('nan')]},
                         {'type': 'Point', 'coordinates': [53.9, -122.7]}]:
            with self.subTest(geometry=geometry):
                data = source()
                data['features'][0]['geometry'] = geometry
                with self.assertRaises(ValueError):
                    normalize(data)


if __name__ == '__main__':
    unittest.main()
