"""Read-only consistency check against cached values in the official toolkit.

Usage: python3 audit-workbook.py /path/to/local_area_economic_profiles_2025_toolkit.xlsx
Requires openpyxl for inspection only; never recalculates or writes the workbook.
"""
import csv
import gzip
import io
import json
import sys
from pathlib import Path

import openpyxl

root = Path(__file__).resolve().parent
workbook = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
sheets = {
    'descriptive-stats': 'Descriptive Stats', 'income-dependencies': 'Income Dependencies',
    'jobs': 'Jobs', 'location-quotients': 'Location Quotients',
    'employment-impact-ratios': 'Employment Impact Ratios',
    'average-incomes': 'Avg Incomes', 'demand-sources': 'Demand Sources',
}
report = []
for stem, sheet in sheets.items():
    data = gzip.decompress((root / 'source' / f'laep-{stem}-by-area.csv.gz').read_bytes())
    records = list(csv.reader(io.StringIO(data.decode('utf-8-sig'))))
    lookup = {str(row[0]): row for row in workbook[sheet].values if isinstance(row[0], int)}
    source_rows = [row for row in records if row and row[0].isdigit()]
    assert set(lookup) == {row[0] for row in source_rows}, f'{sheet}: row keys differ'
    checked, mismatches = 0, []
    for row in source_rows:
        reference = lookup[row[0]]
        for column, text in enumerate(row):
            actual = reference[column]
            if not text and actual is None:
                continue
            checked += 1
            if isinstance(actual, (int, float)):
                try:
                    numeric = float(text.replace(',', '').replace('%', ''))
                    decimals = len(text.rstrip('%').split('.')[1]) if '.' in text else 0
                    tolerance = 0.5 * 10 ** -decimals
                    if '%' in text:
                        numeric /= 100
                        tolerance /= 100
                    same = abs(actual - numeric) <= tolerance + 1e-8
                except ValueError:
                    same = False
            else:
                same = str(actual or '') == text
            if not same:
                mismatches.append({'key': row[0], 'column': column + 1, 'csv': text, 'workbook': actual})
    report.append({'sheet': sheet, 'rows': len(source_rows), 'checkedCells': checked,
                   'mismatchCount': len(mismatches), 'examples': mismatches[:5]})
print(json.dumps(report, indent=2))
sys.exit(int(any(row['mismatchCount'] for row in report)))
