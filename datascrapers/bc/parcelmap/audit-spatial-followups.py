#!/usr/bin/env python3
"""Validate regional labels, missing PIDs, and published boundary exclusions."""
import csv,gzip,json,importlib.util,urllib.parse,urllib.request,zipfile
from pathlib import Path
from collections import Counter
import numpy as np,shapely
from shapely.geometry import shape
from pyogrio.raw import read
ROOT=Path(__file__).resolve().parent
CACHE=ROOT/'source/public-land';OUT=ROOT/'output/public-land'
spec=importlib.util.spec_from_file_location('audit',ROOT/'audit-public-land.py');audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)

def main():
    with gzip.open(CACHE/'ubc-published-geometry.json.gz','rt') as f:pub=json.load(f)
    with gzip.open(CACHE/'regional_districts.json.gz','rt') as f:rd=json.load(f)['data']['features']
    with (CACHE/'audit-geometry-comparison.csv').open() as f:cmp={int(x['OBJECTID']):x for x in csv.DictReader(f)}
    geoms,_=audit.screen.predicate_geometries(np.array([shape(f['geometry']) for f in rd],dtype=object))
    tree=shapely.STRtree(geoms);counts=Counter();examples=[];by_label=Counter()
    for f in pub['features']:
        p=f['properties'];cur=cmp.get(p['OBJECTID']);point=shape(f['geometry']).representative_point()
        hits=tree.query(point,predicate='intersects');actual=[rd[i]['properties']['ADMIN_AREA_NAME'] for i in hits]
        if not hits.size:counts['no_rd_polygon_at_published_interior_point']+=1;continue
        if audit.region(p['RD_Name']) not in [audit.region(v) for v in actual]:
            counts['published_label_disagrees_with_spatial_rd']+=1
            if cur and audit.region(cur['current_regions']) in [audit.region(v) for v in actual]:counts['current_label_agrees_where_published_disagrees']+=1
            key=(p['RD_Name'],';'.join(actual));by_label[key]+=1
            if by_label[key]==1:
                examples.append({'OBJECTID':p['OBJECTID'],'PID':p['PID_Formatted'],'published_region':p['RD_Name'],'spatial_regions':actual,
                                 'current_region':cur['current_regions'] if cur else None,'iou':float(cur['iou']) if cur else None})
    missing=json.loads((CACHE/'audit-missing-pids.json').read_text())
    layer='WHSE_CADASTRE.PMBC_PARCEL_FABRIC_POLY_SVW';control='024336742'
    params={'service':'WFS','version':'2.0.0','request':'GetFeature','typeNames':'pub:'+layer,'outputFormat':'application/json','count':10000,
            'CQL_FILTER':'PID IN ('+','.join("'"+p+"'" for p in missing+[control])+')','propertyName':'PID,PARCEL_NAME,PLAN_NUMBER,OWNER_TYPE,PARCEL_CLASS,PARCEL_STATUS'}
    url='https://openmaps.gov.bc.ca/geo/pub/'+layer+'/ows?'+urllib.parse.urlencode(params)
    fabric_cache=CACHE/'missing-pids-fabric-query.json'
    stored=json.loads(fabric_cache.read_text()) if fabric_cache.exists() else {}
    if stored.get('queryUrl')==url:
        fabric=stored['response']
    else:
        with urllib.request.urlopen(url,timeout=180) as response:fabric=json.load(response)
    assert len(fabric['features'])==int(fabric['numberMatched'])
    fabric_pids={audit.pid(f['properties']['PID']) for f in fabric['features']}
    assert control in fabric_pids,'Fabric positive control failed'
    fabric_cache.write_text(json.dumps({'queryUrl':url,'response':fabric},indent=2))
    print(f'Fabric query: {len(fabric_pids & set(missing))} of {len(missing)} missing PIDs, positive control found',flush=True)
    # Extract the validated archive once for efficient repeated indexed bbox reads.
    extract=ROOT/'source/polygons/extracted';gdb=extract/'pmbc_parcel_poly_sv.gdb'
    marker=extract/'complete.txt'
    manifest=json.loads((ROOT/'output/polygons-manifest.json').read_text())
    if not marker.exists() or marker.read_text()!=manifest['archive']['sha256']:
        import shutil,hashlib
        archive=ROOT/manifest['archive']['file']
        with archive.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==manifest['archive']['sha256']
        if extract.exists():shutil.rmtree(extract)
        extract.mkdir(parents=True)
        with zipfile.ZipFile(archive) as z:
            for name in z.namelist():
                if not (extract/name).resolve().is_relative_to(extract.resolve()):raise ValueError('Unexpected archive path')
            z.extractall(extract)
        marker.write_text(manifest['archive']['sha256'])
    spatial=[]
    for f in pub['features']:
        p=f['properties'];pid=audit.pid(p['PID_NUMBER'])
        if pid not in missing:continue
        g=shape(f['geometry'])
        gm,_,wkb,fields=read(gdb,bbox=g.bounds,columns=['PID','PMBC_PP_SYSID','OWNER_TYPE','PARCEL_CLASS','PLAN_NUMBER'])
        attrs=dict(zip(gm['fields'],fields))
        candidates=[]
        if len(wkb):
            current,_=audit.screen.predicate_geometries(shapely.from_wkb(wkb))
            for j in shapely.STRtree(current).query(g,predicate='intersects'):
                area=float(shapely.area(shapely.intersection(g,current[j])))
                if area<=0:continue
                candidates.append({'current_pid':audit.pid(attrs['PID'][j]),'current_id':int(attrs['PMBC_PP_SYSID'][j]),
                    'owner':str(attrs['OWNER_TYPE'][j]),'parcel_class':str(attrs['PARCEL_CLASS'][j]),'plan':str(attrs['PLAN_NUMBER'][j]),
                    'published_fraction_covered':area/float(g.area),'iou':area/float(shapely.area(shapely.union(g,current[j])))})
        candidates.sort(key=lambda x:x['iou'],reverse=True)
        spatial.append({'OBJECTID':p['OBJECTID'],'published_pid':pid,'best_current_candidates':candidates[:3],
                        'union_fraction_covered':float(shapely.area(shapely.intersection(g,shapely.union_all(current))))/g.area if len(wkb) else 0})
        if len(spatial)%25==0:print('Missing PID footprint checks',len(spatial),flush=True)
    best=[r['best_current_candidates'][0] if r['best_current_candidates'] else {} for r in spatial]
    with (CACHE/'audit-exceptions.csv').open() as stream:exceptions=list(csv.DictReader(stream))
    spatial_exceptions=[r for r in exceptions if r['status']=='excluded_spatially']
    private_exceptions=[r for r in exceptions if r['status']=='current_nonpublic_owner']
    pub_area=np.array([shape(f['geometry']).area for f in pub['features']])
    with gzip.open(CACHE/'parcel-decisions.csv.gz','rt') as stream:
        retained_ids={int(r['PMBC_PP_SYSID']) for r in csv.DictReader(stream) if r['retained']=='1'}
    meta,_,_,columns=read(gdb,columns=['PMBC_PP_SYSID','PID','FEATURE_AREA_SQM'],read_geometry=False)
    fields=dict(zip(meta['fields'],columns))
    retained=np.isin(fields['PMBC_PP_SYSID'],list(retained_ids))
    has_pid=np.array([audit.pid(v) is not None for v in fields['PID']])
    size_range=(fields['FEATURE_AREA_SQM']>=100)&(fields['FEATURE_AREA_SQM']<=20000)
    summary={'regional_spatial_check':dict(counts),'regional_label_pairs':[{'published':a,'spatial':b,'records':n} for (a,b),n in by_label.most_common()],
        'regional_examples':examples,'fabric_missing_pid_check':{'requested_missing_pids':len(missing),'found_missing_pids':len(fabric_pids & set(missing)),
            'positive_control_pid':control,'positive_control_found':True,'response_timestamp':fabric.get('timeStamp'),'layer':layer},
        'missing_pid_spatial_check':{'published_records_checked':len(spatial),'best_current_iou_at_least_0_99':sum(r.get('iou',0)>=.99 for r in best),
             'best_current_iou_at_least_0_95':sum(r.get('iou',0)>=.95 for r in best),'no_intersecting_current_parcel':sum(not r for r in best),
             'best_candidates_without_pid':sum(r.get('current_pid') is None for r in best if r),
             'best_candidate_owner_types':dict(Counter(r.get('owner') for r in best if r)),
             'best_candidate_parcel_classes':dict(Counter(r.get('parcel_class') for r in best if r))},
        'published_footprint_checks':{
            'spatial_exceptions_published_overlap_at_least_50pct':sum(float(r['published_overlap_fraction'])>=.5 for r in spatial_exceptions),
            'spatial_exceptions_iou_at_least_0_99':sum(float(r['iou'])>=.99 for r in spatial_exceptions),
            'spatial_exceptions_iou_at_least_0_99_and_published_overlap_at_least_50pct':sum(float(r['iou'])>=.99 and float(r['published_overlap_fraction'])>=.5 for r in spatial_exceptions),
            'private_exceptions_iou_at_least_0_99':sum(float(r['iou'])>=.99 for r in private_exceptions),
            'published_geometry_area_above_2ha':int((pub_area>20000).sum()),
            'published_geometry_area_above_2_1ha':int((pub_area>21000).sum()),
            'published_geometry_area_above_10ha':int((pub_area>100000).sum()),
            'published_geometry_max_area_ha':float(pub_area.max()/10000),
        },
        'diagnostic_candidate_filters':{
            'retained':int(retained.sum()),'with_pid':int((retained & has_pid).sum()),
            'within_100m2_to_2ha':int((retained & size_range).sum()),
            'with_pid_and_within_100m2_to_2ha':int((retained & has_pid & size_range).sum()),
            'applied_to_baseline':False,
        },
        'limitations':['Regional checks locate a representative interior point, not a whole-polygon region overlay; parcels spanning boundaries can differ legitimately.',
                       'A current footprint match under another PID is evidence of changed identifiers or source representation, not proof of a dated subdivision or title history.',
                       'Fabric is queried at the current date and cannot establish historical January strata membership.']}
    (CACHE/'audit-missing-pid-footprints.json').write_text(json.dumps(spatial,indent=2))
    (OUT/'audit-followups.json').write_text(json.dumps(summary,indent=2)+'\n')
    print(json.dumps({k:v for k,v in summary.items() if k not in ['regional_examples','regional_label_pairs']},indent=2))

if __name__=='__main__':main()
