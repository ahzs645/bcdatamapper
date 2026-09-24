import unittest
from calculations import audit_family
from normalize import boundary_geometry


def family(values):
    return {'regions':[{'id':'GEOSD_57','observations':[
        {'wave':9,'measure':key,'value':value,'status':'reported' if value is not None else 'not_reported_or_suppressed'}
        for key,value in values.items()
    ]}]}


class CalculationTests(unittest.TestCase):
    def test_scale_denominator_is_not_demographic_or_valid_total(self):
        f = family({'count_overall_vulnerable':349,'count_overall_in_flux':193,
                    'count_overall_on_track':291,'pct_overall_vulnerable':41.9,
                    'count_total_valid_edi_cases':850,'count_total_edi_cases':900})
        self.assertEqual(audit_family(f)['matches'],1)
        check = f['regions'][0]['observations'][3]['calculation']
        self.assertEqual(check['denominator'],833)
        self.assertAlmostEqual(check['value'],41.89675870348139)

    def test_suppressed_or_zero_denominator_is_not_inferred_from_percent(self):
        for missing in [None,0]:
            f = family({'count_social_vulnerable':0,'count_social_at_risk':missing,
                        'count_social_on_track':0,'pct_social_vulnerable':0})
            self.assertEqual(audit_family(f),{'unavailable':1})

    def test_difference_is_reported_without_replacing_source(self):
        f = family({'count_social_vulnerable':1,'count_social_at_risk':1,
                    'count_social_on_track':1,'pct_social_vulnerable':30})
        self.assertEqual(audit_family(f)['differs'],1)
        self.assertEqual(f['regions'][0]['observations'][3]['value'],30)

    def test_zero_numerator_and_multiple_count_partition(self):
        f = family({'count_overall_vulnerable':3,'count_overall_in_flux':2,'count_overall_on_track':5,
                    'pct_multiple_1':0,'count_multiple_1':0,'count_multiple_2':2,
                    'count_multiple_3':0,'count_multiple_4':0,'count_multiple_5':1})
        self.assertEqual(audit_family(f),{'matches':1,'multipleCounts_matches':1})
        f['regions'][0]['observations'][-1]['value']=2
        self.assertEqual(audit_family(f)['multipleCounts_differs'],1)

    def test_geometry_reuse_keeps_membership_and_coordinates_exact(self):
        a={'type':'FeatureCollection','metadata':{'wave':2},'features':[
            {'type':'Feature','properties':{'regionId':'HA_1','regionName':'Old label'},
             'geometry':{'type':'Polygon','coordinates':[[[0,0],[1,0],[1,1],[0,0]]]}}]}
        b={**a,'metadata':{'wave':9},'features':[{**a['features'][0],'properties':{'regionId':'HA_1','regionName':'New label'}}]}
        self.assertEqual(boundary_geometry(a),boundary_geometry(b))
        b['features'][0]['properties']['regionId']='HA_2'
        self.assertNotEqual(boundary_geometry(a),boundary_geometry(b))
        self.assertEqual(boundary_geometry(a)['features'][0]['geometry'],a['features'][0]['geometry'])


if __name__=='__main__': unittest.main()
