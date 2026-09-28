import copy,gzip,importlib.util,json,unittest
from pathlib import Path
import pyreadr
ROOT=Path(__file__).parent
spec=importlib.util.spec_from_file_location('validator',ROOT/'validate-current-pilot.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

def fixture():
    return {'schema':'cciss-current-pilot-v1','requestValid':True,'requestedSites':[1],
      'dimensions':[{'array_ordinal':1,'gcm_id':1,'scenario_id':1,'futureperiod_id':1,'run_id':1}],
      'bgcCodes':[{'bgc_id':2,'bgc':'Example'}],'future':[{'siteno':1,'bgc_id':[2]}],
      'observed':[{'siteno':1}],'novelty':[{'siteno':1,'novelty':[0.5]}],
      'attribution':[{'siteno':1}], 'siteGeometry':[{'siteno':1,'geometry':{'type':'Polygon','coordinates':[[[0,0],[1,0],[1,1],[0,0]]]}}]}

class InputTests(unittest.TestCase):
    def test_reference_values_with_independent_r_reader(self):
        manifest=json.loads((ROOT/'output/current-reference/manifest.json').read_text())
        for name in ['E1','E1_Phase','S1','R1','F1','silvics_tol','silvics_resist','silvics_regen','silvics_mature']:
            with self.subTest(table=name):
                original=pyreadr.read_r(str(ROOT/'sources/ccissr'/manifest['packageCommit']/'data'/(name+'.rda')))[name]
                entry=next(t for t in manifest['tables'] if t['table']==name and t['group']=='package')
                converted=json.loads(gzip.decompress((ROOT/'output/current-reference'/entry['file']).read_bytes()))
                expected=json.loads(original.to_json(orient='split',double_precision=15))
                self.assertEqual(converted['columns'],expected['columns'])
                self.assertEqual(converted['rows'],expected['data'])
        self.assertFalse(manifest['compatibility']['readyForCurrentShiny'])
    def test_csv_encoding_preserved(self):
        data=json.loads(gzip.decompress((ROOT/'output/current-reference/catalogue-site_series.json.gz').read_bytes()))
        self.assertEqual(data['source']['sourceEncoding'],'cp1252')
        self.assertFalse(any('\ufffd' in str(r) for r in data['rows']))
    def test_valid_synthetic_structure(self):
        self.assertEqual(module.validate(fixture()),[])
    def test_rejects_shifted_ordinals(self):
        d=fixture();d['dimensions'][0]['array_ordinal']=2
        self.assertIn('Non-contiguous array ordinals',module.validate(d))
    def test_rejects_unmatched_array(self):
        d=fixture();d['future'][0]['bgc_id']=[2,2]
        self.assertIn('Future array length does not match dimensions',module.validate(d))
    def test_rejects_unknown_code(self):
        d=fixture();d['future'][0]['bgc_id']=[9]
        self.assertIn('Unknown BGC code in future array',module.validate(d))
    def test_rejects_missing_site(self):
        d=fixture();d['attribution']=[]
        self.assertIn('attribution: missing, duplicate or unexpected sites',module.validate(d))
    def test_rejects_duplicate_site(self):
        d=fixture();d['observed'].append(copy.deepcopy(d['observed'][0]))
        self.assertIn('observed: missing, duplicate or unexpected sites',module.validate(d))
    def test_rejects_empty_request(self):
        d=fixture();d['requestedSites']=[]
        self.assertTrue(module.validate(d))

if __name__=='__main__':unittest.main()
