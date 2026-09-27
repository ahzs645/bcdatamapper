import contextlib
import io
import unittest
from collections import defaultdict
import build

class GeographyBridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with contextlib.redirect_stdout(io.StringIO()):
            cls.manifest, cls.blocks, cls.pairs = build.build()

    def test_conservation_and_unique_blocks(self):
        self.assertEqual(len({r['dbuid'] for r in self.blocks}),len(self.blocks))
        groups=defaultdict(list)
        for r in self.pairs: groups[r['censusLevel'],r['healthLevel']].append(r)
        self.assertEqual(len(groups),12)
        for rows in groups.values():
            for metric in ['population','dwellings','households']:
                self.assertEqual(sum(r[metric] for r in rows),sum(r[metric] for r in self.blocks))
            self.assertEqual(sum(r['dbCount'] for r in rows),len(self.blocks))

    def test_population_shares_include_unknowns(self):
        groups=defaultdict(list)
        for r in self.pairs: groups[r['censusLevel'],r['healthLevel'],r['censusCode']].append(r)
        for rows in groups.values():
            if sum(r['population'] for r in rows):
                self.assertAlmostEqual(sum(r['populationShareOfCensus'] for r in rows),1)
        missing=[r for r in self.blocks if r['healthLinkStatus']=='unresolved-parent']
        self.assertEqual(len(missing),533)
        self.assertEqual(sum(r['population'] for r in missing),78916)
        self.assertTrue(all(r['chsaCode']=='2210' and r['healthAuthorityCode'] is None for r in missing))
        self.assertTrue(all(r['populationShareOfHealth'] is None for r in self.pairs if r['healthCode'] is None))

    def test_prince_george_and_many_to_many(self):
        pg=[r for r in self.blocks if r['csdId']=='5953023']
        self.assertTrue(pg)
        self.assertEqual({(r['economicRegionCode'],r['cdId'],r['lhaCode'],r['hsdaCode'],r['healthAuthorityCode']) for r in pg},{('5950','5953','524','52','5')})
        cariboo=[r for r in self.pairs if r['censusLevel']=='economicRegionCode' and r['healthLevel']=='healthAuthorityCode' and r['censusCode']=='5950']
        self.assertEqual({r['healthCode'] for r in cariboo},{'1','3','5'})

    def test_group_observations_not_duplicated(self):
        source=build.read(build.INPUTS['vacancies'])['rows']
        linked=build.read(build.OUT/'job-vacancies-linked.json.gz')['records']
        self.assertEqual([r['source'] for r in linked],source)
        groups=[r for r in linked if r['source']['GEO']=='North Coast and Nechako']
        self.assertTrue(groups)
        self.assertTrue(all(r['geography']['economicRegionCodes']==['5960','5970'] for r in groups))
        north=[r for r in linked if r['source']['GEO']=='Northern B.C.']
        self.assertTrue(all(r['geography']['status']=='definition-unverified' and not r['geography']['economicRegionCodes'] for r in north))

    def test_deterministic_output(self):
        before={p.name:p.read_bytes() for p in build.OUT.iterdir() if p.is_file()}
        with contextlib.redirect_stdout(io.StringIO()): build.build()
        self.assertEqual(before,{p.name:p.read_bytes() for p in build.OUT.iterdir() if p.is_file()})

if __name__=='__main__':unittest.main()
