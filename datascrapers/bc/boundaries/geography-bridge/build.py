#!/usr/bin/env python3
"""Reproducible ID-based census/economic/health bridge; no inferred boundaries."""
import csv
import gzip
import hashlib
import io
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / 'datascrapers/bc/boundaries/output/GeographyBridge'
INPUTS = {
    'blocks': ROOT / 'datascrapers/census/output/bc_db_population_chsa_crosswalk.json',
    'economic': ROOT / 'datascrapers/bc/boundaries/output/StatCan/bc_economic_regions_2021.hierarchy.json',
    'health': ROOT / 'datascrapers/bc/boundaries/output/BCMoH/index.json',
    'inventory': ROOT / 'datascrapers/bc/state-of-north/output/inventory.json',
    'vacancies': ROOT / 'datascrapers/bc/state-of-north/output/jobvacancy_bygeo.json.gz',
}
CENSUS = ['economicRegionCode', 'cdId', 'csdId']
HEALTH = ['chsaCode', 'lhaCode', 'hsdaCode', 'healthAuthorityCode']

def read(path):
    data = path.read_bytes()
    return json.loads(gzip.decompress(data) if path.suffix == '.gz' else data)

def write(name, value):
    data = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode()
    (OUT / name).write_bytes(gzip.compress(data, mtime=0) if name.endswith('.gz') else data)

def build():
    OUT.mkdir(parents=True, exist_ok=True)
    source, economic, health, inventory, vacancies = [read(INPUTS[k]) for k in INPUTS]
    ers = {r['code']: r for r in economic['economicRegions']}
    cds = {r['code']: r for r in economic['censusDivisions']}
    csds = {r['code']: r for r in economic['censusSubdivisions']}
    records = []
    seen = set()
    for row in source['records']:
        assert row['dbuid'] not in seen, 'Duplicate DBUID'
        seen.add(row['dbuid'])
        cd, csd = cds[row['cdId']], csds[row['csdId']]
        assert csd['censusDivisionCode'] == row['cdId'], 'Conflicting CSD/CD membership'
        assert csd['economicRegionCode'] == cd['economicRegionCode'], 'Conflicting ER membership'
        r = {k: row.get(k) for k in ['dbuid','daId','cdId','csdId','csdName','population','dwellings','households',
                                    'chsaCode','chsaName','lhaCode','lhaName','hsdaCode','hsdaName',
                                    'healthAuthorityCode','healthAuthorityName']}
        r.update(economicRegionCode=cd['economicRegionCode'], censusYear=2021,
                 healthLinkStatus='linked' if all(row.get(k) for k in HEALTH) else 'unresolved-parent')
        assert all(isinstance(r[k], (int,float)) and r[k] >= 0 for k in ['population','dwellings','households'])
        records.append(r)
    records.sort(key=lambda r:r['dbuid'])
    population = sum(r['population'] for r in records)
    unresolved = [r for r in records if r['healthLinkStatus'] != 'linked']
    totals = {field:defaultdict(int) for field in CENSUS + HEALTH}
    for r in records:
        for field in totals: totals[field][r[field]] += r['population']
    pairs = []
    for census in CENSUS:
        for hf in HEALTH:
            groups = defaultdict(lambda:dict(dbCount=0,population=0,dwellings=0,households=0))
            for r in records:
                g = groups[(r[census],r[hf])]
                g['dbCount'] += 1
                for key in ['population','dwellings','households']: g[key] += r[key]
            assert sum(g['population'] for g in groups.values()) == population
            assert sum(g['dbCount'] for g in groups.values()) == len(records)
            for (a,b),g in sorted(groups.items(),key=lambda item:str(item[0])):
                pairs.append(dict(censusLevel=census,censusCode=a,healthLevel=hf,healthCode=b,
                    status='linked' if b else 'unresolved-parent',**g,
                    populationShareOfCensus= g['population']/totals[census][a] if totals[census][a] else None,
                    populationShareOfHealth= g['population']/totals[hf][b] if b and totals[hf][b] else None))
    summaries = []
    for code, er in sorted(ers.items()):
        subset = [r for r in records if r['economicRegionCode']==code]
        names = sorted({r['healthAuthorityName'] for r in subset if r['healthAuthorityName']})
        missing = [r for r in subset if r['healthLinkStatus']!='linked']
        summaries.append(dict(economicRegionCode=code,economicRegionName=er['name'],
            dbCount=len(subset),population=sum(r['population'] for r in subset),
            healthAuthorities='; '.join(names),healthAuthorityCount=len(names),
            linkCategory='Incomplete health links' if missing else 'Multiple health authorities' if len(names)>1 else 'One health authority',
            unresolvedDbCount=len(missing),unresolvedPopulation=sum(r['population'] for r in missing),
            profile=f"2021 block crosswalk: {len(subset):,} blocks; {sum(r['population'] for r in subset):,} residents. "
                    f"Linked health authorities: {', '.join(names)}. {len(missing):,} blocks have unresolved health parents. "
                    "Membership is derived from source IDs, not polygon overlap. Population is the covered block universe, not a current estimate."))
    # Exact aliases are specific to this inspected table, never a universal Northern BC definition.
    aliases = {
        'B.C.':dict(geographyType='province',provinceCode='59',economicRegionCodes=[],status='linked'),
        'Cariboo':dict(geographyType='economic-region',economicRegionCodes=['5950'],status='linked'),
        'Northeast':dict(geographyType='economic-region',economicRegionCodes=['5980'],status='linked'),
        'North Coast and Nechako':dict(geographyType='economic-region-group',economicRegionCodes=['5960','5970'],status='linked-group'),
        'Northern B.C.':dict(geographyType='dashboard-region',economicRegionCodes=[],status='definition-unverified'),
    }
    linked_vacancies = []
    for row in vacancies['rows']:
        link = aliases.get(row['GEO'],dict(geographyType='unknown',economicRegionCodes=[],status='unmatched'))
        linked_vacancies.append(dict(source=row,geography=link))
    # Preserve every table/field in a discoverable registry; only pilots have reviewed join guidance.
    guidance = {
        'BC_Mines':('facility-point','Use source coordinates for spatial assignment with boundary/vintage provenance; never nearest-town name as jurisdiction.'),
        'IPPSupplyListOperation_Annually':('project-location','Resolve each project to a verified facility location; NDIT region is a separate geography; location names alone are insufficient.'),
        'ElectricityGeneratingCapacity_Annually':('station-or-dashboard-region','Resolve station identifiers and the Northern BC definition before spatial attribution.'),
        'HousingMedian_Monthly':('city-market','City coordinates locate a market, not its coverage polygon. Resolve market geography and complete the capped extraction; do not aggregate medians.'),
        'Traffic_Ferries_Monthly':('route','Join to verified route/terminal IDs; route totals cannot be assigned to a single economic or health region.'),
        'TourismRevenue_Monthly':('tax-reporting-area','Resolve MRDT reporting areas and changes over time; municipal names do not establish boundary equivalence.'),
        'JobVacancy_ByGEO':('mixed-province-economic-group','Explicit aliases are applied in job-vacancies-linked.json.gz. Keep North Coast and Nechako combined; Northern B.C. definition remains unverified.'),
    }
    samples={s['table']:s for s in inventory['samples']}
    registry=[]
    for table in inventory['tables']:
        name=table['name']; guide=guidance.get(name)
        registry.append(dict(table=name,fields=table['fields'],
            pages=sorted({p['title'] for p in inventory['pages'] if any(name in v['entities'] for v in p['visuals'])}),
            extraction=samples.get(name),geographyType=guide[0] if guide else 'requires-review',
            joinGuidance=guide[1] if guide else 'Schema inventory only. Verify geography, unit, period, dimensions and source definition before linking.',
            integrationStatus='linked-with-unresolved-group' if name=='JobVacancy_ByGEO' else 'extraction-pilot' if guide else 'schema-only'))
    current={r['code'] for r in health['communityHealthServiceAreas']}
    old={r['chsaCode'] for r in records}
    manifest=dict(schema='bc-geography-bridge-v1',censusYear=2021,
        method='Official 2021 ER/CD/CSD IDs joined to existing DB/CHSA assignments and existing health-parent fields. No spatial reassignment or code-prefix inference.',
        sourceFiles={k:dict(path=str(p.relative_to(ROOT)),sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for k,p in INPUTS.items()},
        sourceBlockManifest=source['manifest'],dashboardModelLastRefresh=inventory['modelLastRefresh'],
        counts=dict(blocks=len(records),economicRegions=len(ers),censusDivisions=len(cds),censusSubdivisions=len(csds),
                    coveredCensusSubdivisions=len({r['csdId'] for r in records}),population=population,
                    unresolvedHealthBlocks=len(unresolved),unresolvedHealthPopulation=sum(r['population'] for r in unresolved)),
        healthVintage=dict(boundaryVintage='Not established by the local index; not asserted to be 2021',
            currentChsasAbsentFromBlockCrosswalk=sorted(current-old),blockChsasAbsentFromCurrentIndex=sorted(old-current)),
        unresolvedChsaCodes=sorted({r['chsaCode'] for r in unresolved}),
        caveats=['Covered block universe only: source manifest reports 36 extra population DB records outside its crosswalk.',
                 'Pair tables repeat the population in 12 different geography comparisons; filter to one comparison before summing.',
                 'Shares describe 2021 resident distribution, not arbitrary economic-output allocation weights.',
                 'Rates require numerator/denominator recomputation; medians cannot be summed or averaged into valid aggregate medians.',
                 'One group observation is retained once. Never duplicate North Coast/Nechako values onto both regions.',
                 'The current health boundary index and source CHSA crosswalk have different code sets. No silent replacement.'])
    write('manifest.json',manifest)
    write('blocks.json.gz',dict(records=records))
    write('relationships.json.gz',dict(records=pairs))
    stream=io.StringIO(); writer=csv.DictWriter(stream,fieldnames=list(pairs[0]));writer.writeheader();writer.writerows(pairs)
    (OUT/'relationships.csv.gz').write_bytes(gzip.compress(stream.getvalue().encode(),mtime=0))
    write('economic-region-profiles.json',dict(records=summaries))
    write('dashboard-registry.json',dict(modelLastRefresh=inventory['modelLastRefresh'],tables=registry))
    write('job-vacancies-linked.json.gz',dict(modelLastRefresh=vacancies['modelLastRefresh'],completeDistinctRows=vacancies['completeDistinctRows'],records=linked_vacancies))
    (OUT/'methodology.md').write_bytes(Path(__file__).with_name('README.md').read_bytes())
    print(json.dumps(manifest['counts'],indent=2))
    return manifest,records,pairs

if __name__ == '__main__': build()
