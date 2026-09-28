"""Validate an owner-supplied export before accepting it as calculator input."""
import argparse,json
from pathlib import Path

def validate(d):
    errors=[]
    if d.get('schema')!='cciss-current-pilot-v1':errors.append('Unexpected schema')
    if d.get('requestValid') is not True:errors.append('Export request was not valid')
    ids=d.get('requestedSites',[])
    if not isinstance(ids,list) or not 1<=len(ids)<=25 or any(type(x) is not int for x in ids):
        errors.append('Expected 1–25 integer requested site IDs');return errors
    wanted=set(ids)
    dims=d.get('dimensions') or []
    if not dims:errors.append('Missing model dimensions')
    if [x.get('array_ordinal') for x in dims]!=list(range(1,len(dims)+1)):errors.append('Non-contiguous array ordinals')
    keys=[tuple(x.get(k) for k in ['gcm_id','scenario_id','futureperiod_id','run_id']) for x in dims]
    if any(None in k for k in keys) or len(set(keys))!=len(keys):errors.append('Missing or duplicate dimension IDs')
    codes=d.get('bgcCodes') or []
    code_ids={r.get('bgc_id') for r in codes}
    if not codes or None in code_ids or len(code_ids)!=len(codes):errors.append('Invalid BGC codebook')
    for section in ['future','observed','novelty','attribution','siteGeometry']:
        rows=d.get(section) or [];got=[r.get('siteno') for r in rows]
        if set(got)!=wanted or len(got)!=len(wanted):errors.append(f'{section}: missing, duplicate or unexpected sites')
    for r in d.get('future') or []:
        values=r.get('bgc_id')
        if not isinstance(values,list) or len(values)!=len(dims):errors.append('Future array length does not match dimensions');continue
        if any(v is not None and v not in code_ids for v in values):errors.append('Unknown BGC code in future array')
    for r in d.get('novelty') or []:
        if not isinstance(r.get('novelty'),list) or len(r['novelty'])!=len(dims):errors.append('Novelty array length does not match dimensions')
    for r in d.get('siteGeometry') or []:
        g=r.get('geometry') or {}
        if g.get('type') not in ['Polygon','MultiPolygon'] or not g.get('coordinates'):errors.append('Missing polygon for site lookup')
    return errors

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('file',type=Path);args=p.parse_args()
    errors=validate(json.loads(args.file.read_text()))
    print(json.dumps({'structurallyValid':not errors,'errors':errors,'note':'Passing this structural gate does not confirm deployed version or ecological correctness.'},indent=2))
    raise SystemExit(1 if errors else 0)
