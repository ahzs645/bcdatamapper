"""Acquire pinned public CCISS reference inputs and convert them for browser use.
uv run --with rdata==1.1.0 --with pandas==3.0.6 python prepare-current-inputs.py --download
Never contacts a PostgreSQL server or uses credentials embedded in source examples.
"""
import argparse,csv,gzip,hashlib,io,json,urllib.request,urllib.parse,warnings
from pathlib import Path
import rdata
import pandas as pd

ROOT=Path(__file__).parent
PACKAGE='a6ab8ee3a714ebf4a3f41e16f04d9f58404de7ce'
CATALOGUE='dacdf055cd45a6f4d6873e107a5b7615efd877cd'
TABLES=['E1','E1_Phase','S1','R1','F1','SS','N1','T1','WNA_BGCs','BGCRegions','models_info','stocking_standards','stocking_info','stocking_height','cfrg_rules','footnotes','silvics_tol','silvics_resist','silvics_regen','silvics_mature','subzones_colours_ref','zones_colours_ref','bgc_colours_v13']
CSVS=['edatopic','suitability','site_series','WNA_BGCs_Info']
parser=argparse.ArgumentParser();parser.add_argument('--download',action='store_true');parser.add_argument('--output',type=Path,default=ROOT/'output/current-reference');args=parser.parse_args()
args.output.mkdir(parents=True,exist_ok=True)
def sha(b):return hashlib.sha256(b).hexdigest()
def source(commit,path):
    p=ROOT/'sources/ccissr'/commit/path
    url='https://raw.githubusercontent.com/bcgov/ccissr/'+commit+'/'+urllib.parse.quote(path)
    if args.download:
        p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(urllib.request.urlopen(url,timeout=45).read())
    return p,{'url':url,'sha256':sha(p.read_bytes()),'bytes':p.stat().st_size}
def write(name,group,columns,records,provenance,dtypes=None):
    assert len(columns)==len(set(columns))
    assert all(len(r)==len(columns) for r in records)
    obj={'schema':'cciss-reference-table-v1','group':group,'table':name,'columns':columns,'rows':records,'dtypes':dtypes,'source':provenance}
    raw=json.dumps(obj,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode()
    packed=gzip.compress(raw,mtime=0);file=f'{group}-{name}.json.gz';(args.output/file).write_bytes(packed)
    # Check exact decompression/JSON round trip, column order, nulls and values.
    assert json.loads(gzip.decompress(packed))==obj
    return {'table':name,'group':group,'file':file,'rows':len(records),'columns':columns,'bytes':len(packed),'sha256':sha(packed),'source':provenance,'replacementCharacters':raw.decode().count('\ufffd')}
entries=[]
for name in TABLES:
    p,provenance=source(PACKAGE,f'data/{name}.rda')
    with warnings.catch_warnings(record=True) as ws:
        obj=rdata.read_rda(p,default_encoding='cp1252')
    df=obj[name]
    assert isinstance(df,pd.DataFrame),name
    # R's unmarked native strings require a fallback; explicit UTF-8 markers win.
    provenance['nativeEncodingFallback']='cp1252'
    provenance['conversionWarnings']=sorted(set(str(w.message) for w in ws))
    split=json.loads(df.to_json(orient='split',date_format='iso',double_precision=15))
    entries.append(write(name,'package',split['columns'],split['data'],provenance,{str(k):str(v) for k,v in df.dtypes.items()}))
for name in CSVS:
    p,provenance=source(CATALOGUE,f'tables/{name}.csv')
    try:
        text=p.read_bytes().decode('utf-8-sig');encoding='utf-8-sig'
    except UnicodeDecodeError:
        text=p.read_bytes().decode('cp1252');encoding='cp1252'
    provenance['sourceEncoding']=encoding
    reader=csv.reader(io.StringIO(text,newline=''));cols=next(reader);records=list(reader)
    # Keep CSV lexical types/NA markers intact; no guessed coercion or alias mapping.
    provenance['valueEncoding']='CSV strings, including original NA markers'
    entries.append(write(name,'catalogue',cols,records,provenance))
# These names are consumed literally by the downloaded Shiny/ccissOutput source.
actual=next(e for e in entries if e['table']=='S1' and e['group']=='package')['columns']
required=['BGC','SS_NoSpace','Spp','Feasible','OHR']
compatibility={'readyForCurrentShiny':False,'missingS1Columns':sorted(set(required)-set(actual)),'reason':'Pinned development S1 uses a different schema from the downloaded Shiny/ccissOutput. No column aliases or rating semantics assumed. Prediction arrays and exact site lookup are also absent.'}
manifest={'schema':'cciss-current-reference-manifest-v1','packageCommit':PACKAGE,'catalogueCommit':CATALOGUE,'packageVersion':'1.0.3','deployedVersionVerified':False,'tables':entries,'compatibility':compatibility,'conversion':{'rdata':rdata.__version__,'pandas':pd.__version__},'missingData':['cciss_future14_array','cciss_current14','cciss_novelty14_array','bgc_attribution14','bgc14','gcm','scenario','futureperiod','run','hex_grid','bc_elevation','bec_info','bcb_hres','bc_forest_regions']}
(args.output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'tables':len(entries),'rows':sum(e['rows'] for e in entries),'gzipBytes':sum(e['bytes'] for e in entries),'compatibility':compatibility}))
