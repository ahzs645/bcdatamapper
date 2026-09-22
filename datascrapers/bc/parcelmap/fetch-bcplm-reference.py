#!/usr/bin/env python3
"""Cache the current published BCPLM layer for a read-only comparison."""
from pathlib import Path
import urllib.request,urllib.parse,json,gzip,concurrent.futures,time
root=Path(__file__).resolve().parent / 'source' / 'public-land'
root.mkdir(parents=True, exist_ok=True)
base='https://services2.arcgis.com/NlsizNmbMFiinWw4/arcgis/rest/services/BCPLM_Apr13/FeatureServer/214'
fields='OBJECTID,PID_NUMBER,PID_Formatted,ROLL_NUMBER,JURISDICTION_CODE,OwnerType,OwnerType_Clean,RD_Name,Area_m2,Shape_Circularity,Actual_Use_Derived,Full_Address'
def get(url):
 for i in range(3):
  try:
   d=json.load(urllib.request.urlopen(url,timeout=180))
   if 'error' in d:raise ValueError(d['error'])
   return d
  except Exception:
   if i==2:raise
   time.sleep(1+i)
meta=get(base+'?f=json');count=get(base+'/query?where=1%3D1&returnCountOnly=true&f=json')['count']
def fetch(offset):
 p=dict(where='1=1',outFields=fields,returnGeometry='true',outSR=3005,orderByFields='OBJECTID ASC',resultRecordCount=2000,resultOffset=offset,f='geojson')
 d=get(base+'/query?'+urllib.parse.urlencode(p))
 assert d.get('crs',{}).get('properties',{}).get('name')=='EPSG:3005'
 print('page',offset,len(d['features']),flush=True)
 return d['features']
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:features=[f for page in pool.map(fetch,range(0,count,2000)) for f in page]
assert len(features)==count==len({f['properties']['OBJECTID'] for f in features})
assert meta.get('editingInfo')==get(base+'?f=json').get('editingInfo')
d={'type':'FeatureCollection','crs':{'type':'name','properties':{'name':'EPSG:3005'}},'metadata':{'url':base,'editingInfo':meta.get('editingInfo'),'queriedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'count':count},'features':features}
p=root/'ubc-published-geometry.json.gz';p.write_bytes(gzip.compress(json.dumps(d,separators=(',',':')).encode(),mtime=0));print('Saved',p.stat().st_size,flush=True)
