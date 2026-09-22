import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('aggregator',Path(__file__).with_name('build-postal-fsa-table.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class AggregationTest(unittest.TestCase):
 def test_unique_codes_missing_values_and_unmapped_fsa(self):
  rows=[{'pc':'v2l 1a1','pm':'2'},{'pc':'V2L1A1','pm':'2'},{'pc':'V2L1A2','pm':'4'},{'pc':'V2L1A3','pm':'NA'},{'pc':'V7X1A1','pm':'6'},{'pc':'bad','pm':'9'},{'pc':'V2L1A4','pm':'-9999'},{'pc':'V2L1A5','pm':'-1111'}]
  result,stats=module.aggregate(rows,'pc',['pm'],{'V2L'})
  self.assertEqual(result[0]['values']['pm'],3)
  self.assertEqual(result[0]['counts']['pm'],2)
  self.assertFalse(result[1]['hasBoundary'])
  self.assertEqual(stats['invalidOrNonBcRows'],1)
 def test_conflicting_duplicate_fails_instead_of_double_counting(self):
  with self.assertRaises(ValueError):module.aggregate([{'pc':'V2L1A1','pm':'2'},{'pc':'V2L1A1','pm':'5'}],'pc',['pm'],{'V2L'})
if __name__=='__main__':unittest.main()
