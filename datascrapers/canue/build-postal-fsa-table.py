#!/usr/bin/env python3
"""Build one reusable FSA value table from a CANUE six-character postal CSV.

No geometry is duplicated. This is an unweighted mean of unique postal-code
observations, not a population-weighted exposure estimate. Input stays local.
"""
import argparse,csv,gzip,hashlib,io,json,math,re,zipfile
from collections import defaultdict
from pathlib import Path

BOUNDARIES=Path(__file__).resolve().parents[1]/'bc/boundaries/output/StatCan/bc_fsa_2021.geojson.gz'

def aggregate(rows,postal_column,value_columns,known_codes):
    seen={};invalid=0;missing=defaultdict(int)
    for row in rows:
        code=re.sub(r'\s+','',row.get(postal_column,'').upper())
        if not re.fullmatch(r'V[0-9][ABCEGHJKLMNPRSTVWXYZ][0-9][ABCEGHJKLMNPRSTVWXYZ][0-9]',code):
            invalid+=1;continue
        values={}
        for column in value_columns:
            text=row.get(column,'').strip()
            if text in ('','NA','NaN','NULL','null'):
                missing[column]+=1;continue
            value=float(text)
            if not math.isfinite(value) or value in (-9999,-1111):missing[column]+=1;continue
            values[column]=value
        if code in seen:
            if seen[code]!=values:raise ValueError(f'Conflicting duplicate postal code: {code}')
            continue
        seen[code]=values
    buckets=defaultdict(lambda:defaultdict(list))
    for code,values in sorted(seen.items()):
        for column,value in values.items():buckets[code[:3]][column].append(value)
    result=[]
    for fsa,columns in sorted(buckets.items()):
        result.append({'boundaryId':fsa,'boundaryName':f'FSA {fsa}','hasBoundary':fsa in known_codes,
            'values':{k:math.fsum(v)/len(v) for k,v in sorted(columns.items())},
            'counts':{k:len(v) for k,v in sorted(columns.items())},
            'min':{k:min(v) for k,v in sorted(columns.items())},
            'max':{k:max(v) for k,v in sorted(columns.items())}})
    return result,{'uniquePostalCodes':len(seen),'invalidOrNonBcRows':invalid,'missingValueRows':dict(missing)}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,required=True,help='CSV or ZIP containing the selected CSV')
    parser.add_argument('--member',help='Exact CSV member name when input is a ZIP')
    parser.add_argument('--postal-column',required=True)
    parser.add_argument('--value-column',action='append',required=True)
    parser.add_argument('--year',type=int,required=True)
    parser.add_argument('--dataset',required=True)
    parser.add_argument('--output',type=Path,required=True,help='Local output JSON; do not publish restricted raw rows')
    args=parser.parse_args()
    blob=args.input.read_bytes()
    if args.input.suffix.lower()=='.zip':
        if not args.member:parser.error('--member is required for ZIP input')
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:csvbytes=archive.read(args.member)
    else:csvbytes=blob
    reader=csv.DictReader(io.StringIO(csvbytes.decode('utf-8-sig')))
    for field in [args.postal_column,*args.value_column]:
        if field not in (reader.fieldnames or []):parser.error(f'Missing CSV field: {field}')
    geometry=json.loads(gzip.decompress(BOUNDARIES.read_bytes()))
    known={f['properties']['CFSAUID'] for f in geometry['features']}
    rows,stats=aggregate(reader,args.postal_column,args.value_column,known)
    output={'version':1,'boundarySetId':'statcan-cfsa-2021-bc',
        'boundarySourceSha256':geometry['metadata']['archiveSha256'],
        'boundaryUrl':'/data/boundaries/StatCan/bc_fsa_2021.geojson.gz',
        'source':'postal','level':'fsa','dataset':args.dataset,'year':args.year,
        'sourceSha256':hashlib.sha256(blob).hexdigest(),'csvSha256':hashlib.sha256(csvbytes).hexdigest(),
        'sourceMember':args.member,'method':'postal-prefix-unweighted-mean-v1',
        'caveat':'One observation per unique six-character postal code. Missing values and CANUE -9999/-1111 sentinels excluded. No population weighting. Census polygon membership can differ from postal prefixes. Unmapped prefixes retained.',
        'sourceStats':stats,'rows':rows}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(output,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n')
    print(json.dumps({'output':str(args.output),'bytes':args.output.stat().st_size,'fsaRows':len(rows),**stats}))

if __name__=='__main__':main()
