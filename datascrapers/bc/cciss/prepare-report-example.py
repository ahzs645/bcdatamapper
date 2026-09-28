"""Package the pinned, real ccissr CSV example without remapping its old periods.

python3 prepare-report-example.py [--download]
Uses only the Python standard library; does not contact the CCISS database.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).parent
COMMIT = 'a6ab8ee3a714ebf4a3f41e16f04d9f58404de7ce'
RELATIVE = 'data-raw/outputs/WilliamsLake_CCISS_Raw_Table.csv'
EXPECTED = '1a543d01033d1f6252d1b749b063ac0ee2accadff7d0868ce34d5d41916fce62'
parser = argparse.ArgumentParser()
parser.add_argument('--download', action='store_true')
args = parser.parse_args()
source = ROOT / 'sources/ccissr' / COMMIT / RELATIVE
url = f'https://raw.githubusercontent.com/bcgov/ccissr/{COMMIT}/{RELATIVE}'
if args.download:
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(urlopen(url, timeout=45).read())
raw = source.read_bytes()
assert hashlib.sha256(raw).hexdigest() == EXPECTED, 'Pinned source checksum changed'
out = ROOT / 'output/report-examples'
out.mkdir(parents=True, exist_ok=True)
packed = gzip.compress(raw, mtime=0)
assert gzip.decompress(packed) == raw
(out / 'williams-lake-raw.csv.gz').write_bytes(packed)
manifest = {
    'source': f'https://github.com/bcgov/ccissr/blob/{COMMIT}/{RELATIVE}',
    'sourceSha256': EXPECTED,
    'bytes': len(packed),
    'status': 'Historical published example, not calculated for the map point; original period identifiers retained.',
}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest))
