"""Build a geometry-free MHCCA input release and reproducible audit. Requires numpy.

The manually reviewed Table 2 crosswalk is kept here as catalogue IDs. It is an
audit interpretation, not an assertion of the authors' actual model matrix.
"""
import csv
import gzip
import hashlib
import io
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'source'
OUT = ROOT / 'output'
EXCLUDED = {10, 12, 18, 21, 31, 35, 36, 42}
AMBIGUOUS = {32, 64, 65, 66, 67, 68, 76, 77, 78, 79, 80}
PROJECTED = {39, 40, 43, 44}
CANDIDATES = {
    1: ['grlan_amn'], 2: ['nhnse_ava', 'nhnse_avb'], 3: ['nhbld_ava'],
    4: ['nhfac_ava'], 5: ['nhpmd_ann'], 6: ['nhpmd_ann'], 7: ['nhpmd_ann'],
    8: ['nhbic_ava'], 34: ['pm25dald_a', 'pm25dale_a'], 35: ['wtlst_ava'],
    36: ['wthnrc_a'], 37: ['wthnrc_a'],
}
NOTES = {
    1: '2009–2019 spans 11 calendar years inclusive although called a 10-year average. Resolve endpoints and missing years; inspected R2 series omits 2012.',
    2: 'The 2009–2019 noise period is not covered directly by the inspected R2 series: nhnse_ava ends in 2017 with gaps; nhnse_avb is 2021. Resolve endpoints and noise metric.',
    4: 'Website catalogue says facility richness; report Table 1 says facility density/index at 1000 m. Confirm the field and buffer.',
    17: 'Selected in report Table 2, but absent from the downloadable CSV. Do not substitute household or personal income.',
    19: 'Selected in report Table 2, but absent from the downloadable CSV. Numerator and denominator need definition.',
    21: 'Excluded from Table 2 PCA, but required for the population-multiplied index; retain the field.',
    32: 'Table 1/catalogue say postsecondary degree; Table 2 says university degree holders. These are not equivalent definitions; mapping is provisional.',
    34: 'Two related PM2.5 versions cover the requested years; exact product version and annual averaging not established.',
    35: 'Not selected in Table 2. R2 thermal metric describes a rolling three-year maximum of warm-season means; not verified as the same study average.',
    36: 'Not selected in Table 2 and absent from CSV; the candidate weather series ends in 2015, before the requested 2020 endpoint.',
    37: 'Candidate wthnrc_a ends in 2015, before the required 2011–2020 period. The original source/version remains unresolved.',
    38: 'Exact stations, missing-day handling, heat thresholds and multi-day event counting rules are not provided as executable code.',
    39: 'Exact 2018 PCIC projection release, scenario, baseline and station-to-FSA allocation unverified. Current R2 CMIP6 release is related, not equivalent.',
    40: 'Exact 2018 PCIC projection release, scenario, baseline and station-to-FSA allocation unverified. Current R2 CMIP6 release is related, not equivalent.',
    44: 'Report Tables 1–2 assign population change to adaptive capacity; website catalogue assigns it to sensitivity. Preserve both assignments.',
}


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def pca_diagnostic(rows, fields, reported):
    matrix = np.array([[row['values'][key] for key in fields] for row in rows])
    z = (matrix - matrix.mean(axis=0)) / matrix.std(axis=0, ddof=1)
    singular = np.linalg.svd(z, compute_uv=False)
    shares = singular**2 / np.sum(singular**2) * 100
    return {'fields': fields, 'rows': len(rows), 'method': 'Column-centred, sample-SD standardized PCA via numpy SVD; all 193 rows; no additional transformations',
            'variancePercent': shares.tolist(), 'firstTwoVariancePercent': float(shares[:2].sum()),
            'reportedFirstTwoVariancePercent': reported, 'matchesReportWithinOnePercentagePoint': bool(abs(shares[:2].sum() - reported) < 1)}


def build():
    OUT.mkdir(exist_ok=True)
    raw = (SOURCE / 'mhcca-fsa-inputs.csv').read_bytes()
    provenance = json.loads((SOURCE / 'download-provenance.json').read_text())
    assert hashlib.sha256(raw).hexdigest() == provenance['sha256'], 'Source checksum changed; review the release'
    source_rows = list(csv.DictReader(io.StringIO(raw.decode())))
    catalogue = list(csv.DictReader((SOURCE / 'catalogue.csv').open()))
    assert len(source_rows) == 193 and len({r['FSA'] for r in source_rows}) == 193
    assert len(catalogue) == 80
    fields = [k for k in source_rows[0] if k not in ('FSA', 'location_name')]
    assert len(fields) == 76 and set(fields) == {v['csv_field'] for v in catalogue if v['csv_field']}
    boundaries = json.loads(gzip.decompress((ROOT.parent / 'boundaries/output/StatCan/bc_fsa_2021.geojson.gz').read_bytes()))
    codes = {f['properties']['CFSAUID'] for f in boundaries['features']}
    rows = [{'fsa': r['FSA'], 'name': r['location_name'], 'mapped': r['FSA'] in codes,
             'values': {key: float(r[key]) for key in fields}} for r in source_rows]
    matrix = np.array([[r['values'][key] for key in fields] for r in rows])
    assert np.isfinite(matrix).all()
    variables = []
    for entry in catalogue:
        i = int(entry['id'])
        selected = 'not_selected' if i in EXCLUDED else 'ambiguous' if i in AMBIGUOUS else 'selected'
        component = 'Adaptive capacity' if i == 44 else entry['component']
        note = NOTES.get(i, '')
        if i in AMBIGUOUS - {32}:
            note = 'Table 2 repeats five disease-incidence labels without distinguishing rates from counts. Table 1 and the CSV contain separate rate and count fields; both are retained but exact PCA inclusion needs code.'
        candidates = CANDIDATES.get(i, [])
        if candidates:
            action = 'Verify CANUE version, variable/buffer, year coverage and postal-to-FSA averaging before rebuilding.'
        elif entry['source'] == 'StatCan':
            action = 'Acquire full BC 2021 attributes and establish the DA-to-FSA crosswalk and aggregation rule; counts, rates and medians need different treatment.'
        elif entry['source'] == 'BC Community Health Data':
            action = 'Match original LHA table/vintage and establish the LHA-to-FSA allocation. Current EDI data is not automatically the 2013–2016 health input.'
        else:
            action = 'Acquire the exact source release and document its geographic assignment to FSA.'
        values = matrix[:, fields.index(entry['csv_field'])] if entry['csv_field'] else None
        variables.append({'catalogueId': i, 'field': entry['csv_field'] or None, 'label': entry['variable'],
                          'source': entry['source'], 'period': entry['source_period'], 'originalGeography': entry['source_geography'],
                          'catalogueComponent': entry['component'], 'reportComponent': component,
                          'selection': selected, 'projected': i in PROJECTED,
                          'available': entry['in_download'] == 'yes', 'reportReference': 'Table 1 pp. 5–10; Table 2 pp. 12–13',
                          'notes': note, 'localStatus': entry['prior_local_status'], 'r2Status': entry['r2_status'],
                          'candidateDatasets': candidates, 'exactPrimitiveMatch': False, 'nextAction': action,
                          'min': float(values.min()) if values is not None else None,
                          'max': float(values.max()) if values is not None else None,
                          'uniqueValues': len(set(values)) if values is not None else 0})
    summary = {'catalogueVariables': 80, 'downloadVariables': 76, 'rows': 193, 'mappedRows': sum(r['mapped'] for r in rows),
               'unmappedFsas': [r['fsa'] for r in rows if not r['mapped']],
               'selectedClear': sum(v['selection'] == 'selected' for v in variables),
               'selectedAmbiguous': sum(v['selection'] == 'ambiguous' for v in variables),
               'notSelected': sum(v['selection'] == 'not_selected' for v in variables),
               'missingSelected': [v['label'] for v in variables if v['selection'] == 'selected' and not v['available']],
               'missingExcluded': [v['label'] for v in variables if v['selection'] == 'not_selected' and not v['available']],
               'nonFiniteValues': int((~np.isfinite(matrix)).sum()),
               'constantFields': [key for j, key in enumerate(fields) if len(set(matrix[:, j])) == 1]}
    observed = ['avg10yr_annual_precipitation', 'pm25_fsa_avg10yr_2020', 'total_heat']
    diagnostics = {'observedExposure': pca_diagnostic(rows, observed, 100),
                   'projectedExposure': pca_diagnostic(rows, observed + ['2020s_summer_tmean_change', '2050s_summer_tmean_change'], 96),
                   'interpretation': 'Diagnostic only, not a reconstructed CVI. The straightforward standardized PCA does not match Table 3. Direction reversals alone cannot explain eigenvalue differences. Input version, transformations or model specification need verification.',
                   'scoreStatus': 'Not reproduced; no final CVI scores emitted'}
    evidence = json.loads((SOURCE / 'holdings-evidence.json').read_text())
    release = {'schemaVersion': 1, 'checkedOn': evidence['checkedOn'], 'sourceUrl': provenance['sourcePage'],
               'sourceSha256': provenance['sha256'], 'reportUrl': evidence['reportUrl'], 'reportSha256': evidence['reportSha256'],
               'boundarySetId': 'statcan-cfsa-2021-bc', 'boundarySource': 'postal', 'boundaryLevel': 'fsa',
               'summary': summary, 'variables': variables, 'rows': rows, 'diagnostics': diagnostics,
               'cautions': ['Author-prepared FSA inputs: already aggregated, averaged and/or imputed; not primitive source observations.',
                            'Colours show input magnitude, not a validated vulnerability score or a universal risk direction.',
                            '2021 census FSA polygons are an exact code join, but identity with the original MHCCA boundary edition is unverified.',
                            'V7X and V7Y retain data rows; no polygons are fabricated.',
                            'Local and R2 source holdings are candidates; no original primitive input is established as an exact match in this audit.']}
    write_json(OUT / 'inputs.json', release)
    write_json(OUT / 'reproducibility.json', diagnostics)
    write_json(OUT / 'holdings-evidence.json', evidence)
    (OUT / 'mhcca-fsa-inputs.csv').write_bytes(raw)
    with (OUT / 'variable-audit.csv').open('w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(variables[0])); writer.writeheader()
        writer.writerows({**v, 'candidateDatasets': '; '.join(v['candidateDatasets'])} for v in variables)
    write_json(OUT / 'manifest.json', {'sourceSha256': provenance['sha256'], 'summary': summary,
               'files': {p.name: {'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                         for p in sorted(OUT.iterdir()) if p.is_file() and p.name != 'manifest.json'}})
    print(json.dumps({'summary': summary, 'diagnostics': diagnostics}, indent=2))


if __name__ == '__main__':
    build()
