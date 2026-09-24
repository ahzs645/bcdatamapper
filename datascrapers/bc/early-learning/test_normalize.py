import unittest
import tempfile
import json
from pathlib import Path
from normalize import metric, observation, encoded, normalize_workbook, dashboard_family, dashboard_library, release_agreement, ROOT

class NormalizationTests(unittest.TestCase):
    def test_missing_and_source_tokens_are_not_zero(self):
        self.assertEqual(observation(8,'x',0)['status'],'reported')
        self.assertIsNone(observation(8,'x',None)['value'])
        self.assertEqual(observation(8,'x','*')['raw'],'*')
        self.assertEqual(observation(9,'score',-0.20)['value'],-0.20)

    def test_units_and_overall_match(self):
        self.assertEqual(metric('% Vulnerable on One or More ')[0],'pct_overall_vulnerable')
        self.assertEqual(metric('# vulnerable on Social domain')[0],'count_social_vulnerable')
        self.assertEqual(metric('% On Track Physical ')[0],'pct_physical_on_track')
        self.assertEqual(metric('% Vulnerable on 0 Scale of the EDI')[0],'pct_multiple_0')

    def test_deterministic_serialization_rejects_nan(self):
        self.assertEqual(encoded({'b':1,'a':2}),encoded({'a':2,'b':1}))
        with self.assertRaises(ValueError): encoded({'value':float('nan')})

    def test_parent_comparison_never_becomes_suppressed_area_value(self):
        raw={'collectorVersion':2,'id':'CHSA_1461','name':'West Cariboo','boundary':'CHSA','requestedWave':9,'demographics':'','participation':'','multipleVulnerabilities':[],
             'scales':[{'scale':'overall','meaningfulChange':'','subscaleChange':'','outcomes':[],'subscales':[], 'vulnerability':[{'name':'Interior','meta':['Interior'],'x':[9],'y':[36.1],'counts':[2175]}]}]}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'area.json'; path.write_text(json.dumps(raw))
            families,_=dashboard_family([path]); observations=families['CHSA']['regions'][0]['observations']
            self.assertTrue(observations)
            self.assertTrue(all(o['value'] is None for o in observations))
            self.assertEqual(next(o['status'] for o in observations if o['wave']==2),'outside_reporting_period')

    def test_same_name_parent_is_disambiguated_by_selected_outcome(self):
        raw={'collectorVersion':2,'id':'NH_N5201','name':'Prince Rupert','boundary':'NH','requestedWave':9,'demographics':'','participation':'','multipleVulnerabilities':[],
             'scales':[{'scale':'overall','meaningfulChange':'','subscaleChange':'','subscales':[],
                        'outcomes':[{'name':'Prince Rupert','x':[30.0],'y':['Vulnerable'],'counts':[30]}],
                        'vulnerability':[{'name':'Prince Rupert','x':[8,9],'y':[45.0,40.0],'counts':[45,40]},
                                         {'name':'Prince Rupert','x':[8,9],'y':[35.0,30.0],'counts':[35,30]}]}]}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'area.json'; path.write_text(json.dumps(raw))
            families,_=dashboard_family([path]); observations=families['NH']['regions'][0]['observations']
            self.assertEqual(next(o['value'] for o in observations if o['wave']==8 and o['measure']=='pct_overall_vulnerable'),35.0)
            self.assertEqual(next(o['value'] for o in observations if o['wave']==9 and o['measure']=='count_overall_vulnerable'),30)
            # If neither series agrees, fail rather than silently choose one.
            raw['scales'][0]['outcomes'][0]['counts']=[99]
            path.write_text(json.dumps(raw))
            with self.assertRaisesRegex(ValueError,'Outcome and trend disagree'): dashboard_family([path])

    def test_same_name_gray_parent_does_not_fill_suppressed_result(self):
        raw={'collectorVersion':2,'id':'NH_N5201','name':'Prince Rupert','boundary':'NH','requestedWave':9,'demographics':'','participation':'','multipleVulnerabilities':[],
             'scales':[{'scale':'overall','meaningfulChange':'','subscaleChange':'','outcomes':[],'subscales':[],
                        'vulnerability':[{'name':'Prince Rupert','x':[9],'y':[40.0],'counts':[40],'lineColor':'rgba(190,190,190,1)'}]}]}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'area.json'; path.write_text(json.dumps(raw))
            families,_=dashboard_family([path])
            self.assertTrue(all(o['value'] is None for o in families['NH']['regions'][0]['observations']))

    def test_single_point_multiple_vulnerability_count_preserves_zero(self):
        raw={'collectorVersion':2,'id':'NH_N4410','name':'Coast Mountains - UNSURVEYED','boundary':'NH','requestedWave':8,'demographics':'','participation':'','scales':[],
             'multipleVulnerabilities':[{'name':'1 Scale','x':[8],'y':[0],'counts':0},{'name':'2 Scales','x':[8],'y':[5.3],'counts':3}]}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'area.json'; path.write_text(json.dumps(raw))
            families,_=dashboard_family([path]); observations=families['NH']['regions'][0]['observations']
            zero=next(o for o in observations if o['wave']==8 and o['measure']=='count_multiple_1')
            self.assertEqual(zero['value'],0); self.assertEqual(zero['status'],'reported')
            self.assertEqual(next(o['value'] for o in observations if o['wave']==8 and o['measure']=='count_multiple_2'),3)

    def test_pre_chsa_aggregate_zero_is_retained_as_source_artifact(self):
        raw={'collectorVersion':2,'id':'CHSA_ALL','name':'All Community Health Service Areas (BC)','boundary':'CHSA','requestedWave':9,'demographics':'','participation':'','scales':[],
             'multipleVulnerabilities':[{'name':'1 Scale','x':[2,7],'y':[0,0],'counts':[0,0]}]}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'area.json'; path.write_text(json.dumps(raw))
            families,_=dashboard_family([path]); observations=families['CHSA']['regions'][0]['observations']
            before=next(o for o in observations if o['wave']==2 and o['measure']=='count_multiple_1')
            self.assertIsNone(before['value']); self.assertEqual(before['sourceValue'],0)
            self.assertEqual(before['status'],'outside_reporting_period')
            during=next(o for o in observations if o['wave']==7 and o['measure']=='count_multiple_1')
            self.assertEqual(during['value'],0); self.assertEqual(during['status'],'reported')

    def test_wave_maps_share_one_polygon_per_region(self):
        square=lambda x:{'type':'Polygon','coordinates':[[[x,50],[x+1,50],[x+1,51],[x,51],[x,50]]]}
        def wave(n,features): return {'metadata':{'displayedWave':n},'features':[{'type':'Feature','geometry':g,'properties':{'regionId':rid,'regionName':rid}} for rid,g in features]}
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'wave-boundaries').mkdir(); (root/'boundaries').mkdir()
            (root/'wave-boundaries/CHSA-7.geojson').write_text(json.dumps(wave(7,[('CHSA_2210',square(-123)),('CHSA_1110',square(-115))])))
            (root/'wave-boundaries/CHSA-9.geojson').write_text(json.dumps(wave(9,[('CHSA_1110',square(-115))])))
            family=dashboard_library(root,{'CHSA':{'regions':[{'id':'CHSA_1110','name':'Fernie'}]}})['CHSA']
            self.assertEqual(len(family['collection']['features']),2)
            self.assertEqual(family['waves'],{7:['CHSA_1110','CHSA_2210'],9:['CHSA_1110']})
            self.assertEqual(family['names'][9],{'CHSA_1110':'Fernie'})
            # A redrawn polygon cannot be folded into one library entry.
            (root/'wave-boundaries/CHSA-9.geojson').write_text(json.dumps(wave(9,[('CHSA_1110',square(-116))])))
            with self.assertRaisesRegex(ValueError,'drawn differently'): dashboard_library(root)

    def test_release_agreement_allows_only_display_rounding(self):
        def family(value,count): return {'regions':[{'id':'CHSA_2210','observations':[
            {'wave':8,'measure':'pct_overall_vulnerable','value':value,'status':'reported'},
            {'wave':8,'measure':'count_overall_vulnerable','value':count,'status':'reported'},
            {'wave':7,'measure':'pct_overall_vulnerable','value':None,'status':'not_reported_or_suppressed'}]}]}
        units={'pct_overall_vulnerable':'percent','count_overall_vulnerable':'count'}
        self.assertEqual(release_agreement(family(24.13,150),family(24.1,150),units),{'overlappingValues':2,'disagreements':0,'examples':[]})
        result=release_agreement(family(24.2,150),family(24.1,151),units)
        self.assertEqual(result['disagreements'],2)
        self.assertEqual(release_agreement(family(24.1,150),{'regions':[]},units)['overlappingValues'],0)

    def test_real_workbook_schema_and_known_total(self):
        path = ROOT.parent/'early-learning-boundaries/cache/EDI_data_library_wave_2_to_8.xlsx'
        if not path.exists(): self.skipTest('Local source cache not present')
        families, measures, notes = normalize_workbook(path)
        self.assertEqual(len(families),10)
        self.assertEqual(len(families['CHSA']['regions']),213)
        self.assertEqual(len(families['NH']['regions']),299)
        for code,family in families.items():
            ids=[r['id'] for r in family['regions']]
            self.assertEqual(len(ids),len(set(ids)),code)
            for region in family['regions']:
                keys=[(o['wave'],o['measure']) for o in region['observations']]
                self.assertEqual(len(keys),len(set(keys)),region['id'])
                self.assertEqual(len(keys),392,region['id'])
        province=families['PROVINCE']['regions'][0]
        value=next(o['value'] for o in province['observations'] if o['wave']==2 and o['measure']=='count_total_edi_cases')
        self.assertEqual(value,38411)
        self.assertIn('pct_multiple_0',measures)
        self.assertTrue(notes)

if __name__=='__main__': unittest.main()
