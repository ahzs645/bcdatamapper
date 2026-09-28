"""Package the downloaded legacy Shiny inputs without changing scientific values.
Requires rasterio/numpy. Outputs deterministic gzip JSON and unchanged GeoTIFFs.
"""
import argparse, csv, gzip, hashlib, json, shutil
from pathlib import Path
import rasterio
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True, type=Path, help='CCISS_ShinyApp root')
parser.add_argument('--output', type=Path, default=Path(__file__).parent/'output/legacy-analysis')
a = parser.parse_args()
source = a.source/'Development/OLD/spatial_app'
data = source/'data'
a.output.mkdir(parents=True, exist_ok=True)
inputs = []
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def record(p):
    inputs.append({'path':str(p.relative_to(a.source)), 'bytes':p.stat().st_size, 'sha256':digest(p)})
def rows(p):
    record(p)
    return list(csv.DictReader(p.open(encoding='utf-8-sig')))
def write(name, value):
    raw=json.dumps(value, separators=(',',':'), allow_nan=False).encode()
    packed=gzip.compress(raw, mtime=0)
    (a.output/name).write_bytes(packed)
    return {'file':name,'bytes':len(packed),'sha256':digest(a.output/name)}
def numeric(v):
    if v in ('NA','NaN',''): return None
    return float(v)

levels = [next(iter(r.values())) for r in rows(data/'levels.bgc.csv')]
sites = {r['BGC']:{e:r[e] for e in ['B2','C4','D6']} for r in rows(data/'SiteLookup.csv')}
ratings = {}
# R match() takes the first duplicate. Preserve that ordering explicitly.
for r in rows(data/'SuitLookup.csv'):
    ratings.setdefault(r['Spp'],{}).setdefault(r['SS_NoSpace'],numeric(r['ESuit']))
names = {r['TreeCode']:r['EnglishName'] for r in rows(data/'Tree speciesand codes_2.0_25Aug2021.csv')}
# The bundled levels.bgc.csv has drifted from the TIFF codes. Recover code labels
# only when each code has a unique identical count signature across ALL 37 BC
# BGC rasters and their independently labelled summary rows. Never guess offsets.
bgc_rows = rows(data/'BC/PredSum.bgc.csv')
columns = list(bgc_rows[0])[5:]
histograms, summary_rows = [], []
for p in sorted((data/'BC').glob('BGC.pred.*.tif')):
    record(p)
    parts=p.stem.split('.')
    model='obs' if parts[2] in ('ref','hist') else parts[2]
    period='1961_1990' if parts[2]=='ref' else parts[-1]
    matches=[r for r in bgc_rows if r['GCM']==model and r['PERIOD']==period and (model=='obs' or r['RUN']==parts[3])]
    assert len(matches)==1, f'Non-unique summary row: {p.name}'
    with rasterio.open(p) as ds:
        v,c=np.unique(ds.read(1,masked=True).compressed().astype(int),return_counts=True)
    histograms.append(dict(zip(v,c)))
    summary_rows.append({k:numeric(matches[0][k]) or 0 for k in columns})
codes=sorted(set().union(*histograms))
recovered=[None]*max(codes)
for code in codes:
    matches=[k for k in columns if all(h.get(code,0)==r[k] for h,r in zip(histograms,summary_rows))]
    assert len(matches)==1, f'Ambiguous BGC code {code}: {matches}'
    recovered[code-1]=matches[0]
code_validation={'method':'Unique BGC count signatures across all BC rasters and matching PredSum.bgc rows', 'rasters':len(histograms),'codes':len(codes),'changedLabels':sum(levels[c-1]!=recovered[c-1] for c in codes),'warning':'Recovered from bundled summaries; not a current CCISS codebook'}
reference=write('reference.json.gz',{'levels':recovered,'sites':sites,'ratings':ratings,'names':names,'codeValidation':code_validation})
regions=[]
for folder in sorted(p for p in data.iterdir() if p.is_dir()):
    tables={}
    for p in sorted(folder.glob('*.csv')):
        if not (p.name.startswith('PredSum.') or p.name.startswith('clim.')): continue
        rr=rows(p)
        if not rr: continue
        identity=[k for k in ['index','GCM','SSP','RUN','PERIOD'] if k in rr[0]]
        columns=[k for k in rr[0] if k not in identity]
        tables[p.stem]={'columns':columns,'rows':[{'id':{k:r[k] for k in identity},'values':[numeric(r[k]) for k in columns]} for r in rr]}
    if tables:
        item=write(folder.name+'.json.gz',{'tables':tables})
        regions.append({'id':folder.name,**item})
rasters=[]
for p in sorted((data/'BC').glob('BGC.pred.*.tif')):
    if 'ensembleMean' in p.name: continue # dominant BGC is not mean species suitability
    record(p)
    with rasterio.open(p) as ds:
        values=ds.read(1,masked=True).compressed()
        assert str(ds.crs)=='EPSG:4326' and ds.transform.a>0 and ds.transform.e<0
        assert np.all(values==np.floor(values)) and values.min()>=1 and values.max()<=len(levels)
        parts=p.stem.split('.')
        meta={'width':ds.width,'height':ds.height,'west':ds.transform.c,'north':ds.transform.f,'dx':ds.transform.a,'dy':ds.transform.e}
    model='Reference' if p.name=='BGC.pred.ref.tif' else 'Observed' if p.name=='BGC.pred.hist.2001_2020.tif' else parts[2]
    period='1961_1990' if model=='Reference' else parts[-1]
    shutil.copyfile(p,a.output/p.name)
    rasters.append({'model':model,'period':period,'scenario':'obs' if model in ['Reference','Observed'] else parts[4], 'run':None if model in ['Reference','Observed'] else parts[3], 'file':p.name,'bytes':p.stat().st_size,'sha256':digest(p),**meta})
for f in ['app.R','LICENSE']:
    record(source/f)
    shutil.copyfile(source/f,a.output/('source-'+f))
manifest={'schema':'cciss-legacy-analysis-v1','status':'Legacy prototype; not current CCISS site-series output','source':'https://github.com/bcgov/CCISS_ShinyApp','sourcePath':'Development/OLD/spatial_app','codeValidation':code_validation,'reference':reference,'regions':regions,'rasters':rasters,'inputs':inputs}
(a.output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'regions':len(regions),'rasters':len(rasters),'bytes':sum(p.stat().st_size for p in a.output.iterdir()),'sourceFiles':len(inputs)}))
