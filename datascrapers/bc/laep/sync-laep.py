"""Acquire BC Stats' published LAEP tables and build the regional story snapshot.

Python standard library only. --refresh downloads catalogue resources; the default
rebuilds deterministic outputs from the committed compressed source snapshots.
The cleaned census input files are archived for audit, never used for indicators.
"""
import argparse
import csv
import gzip
import hashlib
import io
import json
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'source'
OUTPUT = ROOT / 'output'
CATALOGUE = 'https://catalogue.data.gov.bc.ca/api/3/action/package_show?id=local-area-economic-profiles-dataset'
BOUNDARIES = ROOT.parent.parent / 'census/output/bc-da-simplified/parents/cd.geojson'
YEARS = (2010, 2015, 2020)
RD_ALIASES = {
    'Metro Vancouver': 'Greater Vancouver', 'Nanaimo RD': 'Nanaimo',
    'Strathcona RD': 'Strathcona', 'Powell River RD': 'Powell River',
    'Sunshine Coast RD': 'Sunshine Coast', 'Central Coast RD': 'Central Coast',
    'Stikine Region': 'Stikine', 'Northern Rockies RD': 'Northern Rockies',
}
NO_DATA = {'': 'missing', 'F': 'suppressed', 'x': 'suppressed', '-': 'not-reported'}


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url):
    with urlopen(url, timeout=90) as response:
        return response.read()


def refresh():
    SOURCE.mkdir(parents=True, exist_ok=True)
    catalogue = json.loads(fetch(CATALOGUE))['result']
    assert catalogue['license_title'] == 'Open Government Licence - British Columbia'
    resources = []
    for resource in catalogue['resources']:
        if resource['format'].lower() != 'csv':
            continue
        data = fetch(resource['url'])
        filename = resource['url'].split('/')[-1]
        (SOURCE / (filename + '.gz')).write_bytes(gzip.compress(data, mtime=0))
        resources.append({'name': resource['name'], 'url': resource['url'],
                          'file': filename + '.gz', 'sha256': digest(data)})
    (SOURCE / 'manifest.json').write_bytes(encoded({
        'catalogue': CATALOGUE, 'title': catalogue['title'],
        'release': '2025', 'licence': catalogue['license_title'],
        'licenceUrl': catalogue['license_url'], 'resources': resources,
    }))


def rows(filename):
    data = gzip.decompress((SOURCE / (filename + '.gz')).read_bytes())
    resource = next(r for r in json.loads((SOURCE / 'manifest.json').read_text())['resources']
                    if r['file'] == filename + '.gz')
    assert digest(data) == resource['sha256'], f'Source checksum mismatch: {filename}'
    return list(csv.reader(io.StringIO(data.decode('utf-8-sig'))))


def value(raw):
    """Keep suppression and unreported values distinct from genuine zero."""
    if raw in NO_DATA:
        return {'value': None, 'status': NO_DATA[raw]}
    number = float(raw.replace(',', '').replace('%', ''))
    return {'value': number, 'status': 'reported'}


def table(stem):
    data = rows(f'laep-{stem}-by-area.csv')
    headers = next(row for row in data if row[0] == 'Key' and 'Ref_Year' in row
                   and (stem == 'descriptive-stats' or 'Forestry Total' in row))
    records = [dict(zip(headers, row)) for row in data if row and row[0].isdigit()]
    by_key = {(r['Geo_Type'], r['Region Name'], int(r['Ref_Year'])): r for r in records}
    assert len(records) == len(by_key) == 399, f'Duplicate/missing keys in {stem}'
    for year in YEARS:
        assert sum(k[0] == 'EDA' and k[2] == year for k in by_key) == 103
        assert sum(k[0] == 'RD' and k[2] == year for k in by_key) == 29
        assert sum(k[0] == 'PROV' and k[2] == year for k in by_key) == 1
    return by_key


def band(number, edges, labels):
    if number is None:
        return 'Not reported'
    return labels[next((i for i, edge in enumerate(edges) if number < edge), len(edges))]


def build():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((SOURCE / 'manifest.json').read_text())
    tables = {stem: table(stem) for stem in
              ('descriptive-stats', 'income-dependencies', 'jobs', 'location-quotients', 'average-incomes')}
    stats = tables['descriptive-stats']
    assert all(set(t) == set(stats) for t in tables.values()), 'Published tables disagree on region/year keys'
    boundaries = json.loads(BOUNDARIES.read_text())
    rd_ids = {f['properties']['boundaryName']: str(f['properties']['id']) for f in boundaries['features']}
    assert len(rd_ids) == 29
    metrics = {
        'forestry_dependency': ('income-dependencies', 'Forestry Total'),
        'public_dependency': ('income-dependencies', 'Public Sector Total'),
        'transfer_dependency': ('income-dependencies', 'Government transfer income'),
        'market_dependency': ('income-dependencies', 'Non-employment market income'),
        'diversity': ('descriptive-stats', 'Diversity Index'),
        'vulnerability': ('descriptive-stats', 'Forest Sector Vulnerability Index'),
        'forestry_jobs': ('jobs', 'Forestry Total'),
        'forestry_lq': ('location-quotients', 'Forestry Total'),
        'forestry_income': ('average-incomes', 'Forestry Total'),
    }
    all_records = []
    for key in sorted(stats):
        row = stats[key]
        record = {'geography': key[0], 'name': key[1], 'referenceYear': key[2],
                  'censusYear': key[2] + 1, 'parentRd': row['Parent_RD'],
                  'population': value(row['Population']), 'jobs': value(row['Total Jobs']),
                  'dominantIncomeSource': row['Dominant Basic Income Source'],
                  'metrics': {name: value(tables[stem][key][field]) for name, (stem, field) in metrics.items()}}
        if key[0] == 'RD':
            record['id'] = rd_ids[RD_ALIASES.get(key[1], key[1])]
        all_records.append(record)
    assert len({r['id'] for r in all_records if r['geography'] == 'RD'}) == 29
    lookup = {(r['geography'], r['name'], r['referenceYear']): r for r in all_records}
    records = []
    for row in all_records:
        if row['geography'] != 'RD' or row['referenceYear'] != 2020:
            continue
        record = {'id': row['id'], 'name': row['name']}
        for year in (2015, 2020):
            r = lookup[('RD', row['name'], year)]
            for name, metric in r['metrics'].items():
                record[f'{name}_{year}'] = metric['value']
                record[f'{name}_{year}_status'] = metric['status']
        for year in (2015, 2020):
            n = record[f'forestry_dependency_{year}']
            record[f'dependency_band_{year}'] = band(n, [2, 5, 10, 20],
                ['Under 2%', '2 to under 5%', '5 to under 10%', '10 to under 20%', '20% or more'])
            record[f'dependency_label_{year}'] = f"{row['name']}: {n:.1f}%" if n is not None else f"{row['name']}: not reported"
        record['diversity_band'] = band(record['diversity_2020'], [50, 60, 65, 70],
            ['Under 50', '50 to under 60', '60 to under 65', '65 to under 70', '70 or more'])
        record['vulnerability_band'] = band(record['vulnerability_2020'], [10, 25, 50, 75],
            ['Under 10', '10 to under 25', '25 to under 50', '50 to under 75', '75 to 100'])
        record['lq_band'] = band(record['forestry_lq_2020'], [1, 2, 4, 8],
            ['Under 1×', '1 to under 2×', '2 to under 4×', '4 to under 8×', '8× or more'])
        before, after = record['forestry_dependency_2015'], record['forestry_dependency_2020']
        change = round(after - before, 1) if before is not None and after is not None else None
        record['dependency_change_pp'] = change
        record['change_band'] = band(change, [-5, -1, 1, 5],
            ['Below −5 pp', '−5 to below −1 pp', '−1 to below +1 pp', '+1 to below +5 pp', '+5 pp or more'])
        record['change_label'] = f"{row['name']}: {change:+.1f} percentage points" if change is not None else f"{row['name']}: no comparison"
        for metric in ['diversity', 'vulnerability', 'forestry_lq']:
            n = record[f'{metric}_2020']
            record[f'{metric}_label'] = f"{row['name']}: {n:.1f}" if n is not None else f"{row['name']}: not reported"
        def display(name, suffix=''):
            metric = row['metrics'][name]
            return f"{metric['value']:,.1f}{suffix}" if metric['value'] is not None else metric['status'].replace('-', ' ')
        record['details'] = (
            f"2020 model reference year (2021 Census). Forestry income dependency: {display('forestry_dependency', '%')}; "
            f"public-sector dependency: {display('public_dependency', '%')}; government transfers: {display('transfer_dependency', '%')}. "
            f"Diversity index: {display('diversity')}; forest vulnerability index: {display('vulnerability')} (relative to other regional districts, not a probability). "
            f"Forestry employment concentration: {display('forestry_lq', '× BC')}. "
            f"Forestry jobs: {display('forestry_jobs')}, based on residents in the 2021 Census. "
            'Income dependency is the share of modelled external/basic income, not the share of jobs or all household income.'
        )
        record['history_details'] = (
            f"Forestry dependency: {before:.1f}% in 2015; {after:.1f}% in 2020. "
            f"Change: {change:+.1f} percentage points, calculated from published rounded shares. "
            'Both estimates come from the 2025 release. The pandemic affected the 2020/2021 period; '
            'a lower share can reflect other income sources growing. Current boundaries are used for display.'
        ) if change is not None else 'No comparable published forestry dependency values.'
        records.append(record)
    metadata = {'source': manifest, 'referenceYears': list(YEARS),
                'units': {'incomeDependency': 'percent of basic income', 'diversity': 'index, 0–100',
                          'vulnerability': 'relative index, 0–100; compare within geography and period',
                          'forestryLq': 'ratio to BC employment share'},
                'limitations': ['Historical model; not current conditions.',
                    'Jobs and location quotients refer to the census year following the model reference year.',
                    'Local-area geometry is not published here: the source concordance has an unresolved Cassiar/Moricetown conflict.',
                    'Cleaned census source data 2010/2015 are not used: their numeric arrays are identical.']}
    (OUTPUT / 'regional-districts.json').write_bytes(encoded({'metadata': metadata, 'records': records}))
    (OUTPUT / 'area-indicators.json.gz').write_bytes(gzip.compress(encoded({'metadata': metadata, 'records': all_records}), mtime=0))
    first = rows('laep-source-data-2010.csv')[6:]
    second = rows('laep-source-data-2015.csv')[6:]
    audit = {'publishedRecords': len(all_records), 'mappedRegionalDistricts': len(records),
             'cleanedInputNumericRows': len(first),
             'identical2010And2015NumericRows': sum(a[6:] == b[6:] for a, b in zip(first, second)),
             'usesCleanedCensusInputs': False,
             'boundaryGeometry': 'Reuses existing 2021 census divisions without modification',
             'files': {p.name: digest(p.read_bytes()) for p in sorted(OUTPUT.iterdir()) if p.name != 'audit.json'}}
    (OUTPUT / 'audit.json').write_bytes(encoded(audit))
    print(json.dumps(audit, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--refresh', action='store_true')
    args = parser.parse_args()
    if args.refresh:
        refresh()
    build()
