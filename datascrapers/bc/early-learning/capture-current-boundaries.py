#!/usr/bin/env python3
"""Archive current official WFS snapshots without altering shared boundary files."""
import argparse
import datetime
import hashlib
import json
import re
import subprocess
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parent
LAYERS = {
 'HA': ('WHSE_ADMIN_BOUNDARIES.BCHA_HEALTH_AUTHORITY_BNDRY_SP','HLTH_AUTHORITY_CODE','HLTH_AUTHORITY_NAME'),
 'HSDA': ('WHSE_ADMIN_BOUNDARIES.BCHA_HEALTH_SERV_DEL_AREA_SP','HLTH_SERVICE_DLVR_AREA_CODE','HLTH_SERVICE_DLVR_AREA_NAME'),
 'LHA': ('WHSE_ADMIN_BOUNDARIES.BCHA_LOCAL_HEALTH_AREA_SP','LOCAL_HLTH_AREA_CODE','LOCAL_HLTH_AREA_NAME'),
 'CHSA': ('WHSE_ADMIN_BOUNDARIES.BCHA_CMNTY_HEALTH_SERV_AREA_SP','CMNTY_HLTH_SERV_AREA_CODE','CMNTY_HLTH_SERV_AREA_NAME'),
 'GEOSD': ('WHSE_TANTALIS.TA_SCHOOL_DISTRICTS_SVW','SCHOOL_DISTRICT_NUMBER','SCHOOL_DISTRICT_NAME'),
}
CATALOGUES = {'HA':'health-authority-boundaries','HSDA':'health-service-delivery-area-boundaries','LHA':'local-health-area-boundaries','CHSA':'community-health-service-areas-boundaries'}

def enrich(root, family, layer, metadata):
 if family not in CATALOGUES or metadata.get('effectiveEdition'): return metadata
 url='https://catalogue.data.gov.bc.ca/api/3/action/package_show?'+urlencode({'id':CATALOGUES[family]})
 raw=subprocess.check_output(['curl','-fsSL','--max-time','30',url]); result=json.loads(raw)['result']
 # Tie catalogue evidence to this exact WFS feature class, not just its title.
 if layer.split('.')[-1] not in json.dumps(result['resources']): raise ValueError('Catalogue does not identify the WFS feature class')
 match=re.search(r'(20\d{2}) boundary configuration',result.get('notes',''))
 if match:
  metadata['effectiveEdition']=match[1]+' boundary configuration'
  metadata['editionEvidenceUrl']=url
  metadata['editionEvidenceSha256']=hashlib.sha256(raw).hexdigest()
  (root/f'{family}.catalogue.json').write_bytes(raw)
 return metadata

def main():
 parser=argparse.ArgumentParser(); parser.add_argument('--capture',default=datetime.date.today().isoformat()); args=parser.parse_args()
 if not all(c.isalnum() or c in '_-' for c in args.capture): raise ValueError('Invalid capture')
 root=ROOT/'cache/current-boundaries'/args.capture; root.mkdir(parents=True,exist_ok=True)
 for family,(layer,code,name) in LAYERS.items():
  path=root/f'{family}.geojson'; metadata_path=root/f'{family}.source.json'
  if path.exists() and metadata_path.exists():
   metadata=enrich(root,family,layer,json.loads(metadata_path.read_text()))
   metadata_path.write_text(json.dumps(metadata,indent=2)+'\n')
   print(f'{family}: existing capture; edition {metadata.get("effectiveEdition")}'); continue
  url=f'https://openmaps.gov.bc.ca/geo/pub/{layer}/ows?'+urlencode({'service':'WFS','version':'2.0.0','request':'GetFeature','typeNames':layer,'outputFormat':'application/json','srsName':'EPSG:4326'})
  data=subprocess.check_output(['curl','-fsSL','--retry','2','--max-time','180',url]); result=json.loads(data)
  features=result.get('features',[])
  if not features: raise ValueError(f'No features for {family}')
  if isinstance(result.get('numberMatched'),int) and result['numberMatched']!=len(features): raise ValueError('Truncated WFS response')
  codes=[str(f['properties'][code]) for f in features]
  if len(codes)!=len(set(codes)): raise ValueError('Duplicate source region code')
  path.write_bytes(data)
  metadata={'family':family,'sourceUrl':url,'publisher':'Government of British Columbia','retrievedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'effectiveEdition':None,'sha256':hashlib.sha256(data).hexdigest(),'features':len(features),'codeProperty':code,'nameProperty':name,'geometryResolution':'Full WFS geometry; no simplification','licence':'Open Government Licence - British Columbia'}
  metadata=enrich(root,family,layer,metadata)
  metadata_path.write_text(json.dumps(metadata,indent=2)+'\n'); print(f'{family}: {len(features)} features',flush=True)

if __name__=='__main__': main()
