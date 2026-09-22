#!/usr/bin/env python3
"""Audit differences against the cached published BCPLM layer; never alter screening rules."""
import csv,gzip,json,hashlib,importlib.util
from collections import Counter,defaultdict
from pathlib import Path
import numpy as np
import shapely
from shapely.geometry import shape
from pyogrio.raw import read

ROOT=Path(__file__).resolve().parent
CACHE=ROOT/'source/public-land'
OUT=ROOT/'output/public-land'
SPEC=importlib.util.spec_from_file_location('screen',ROOT/'build-public-land.py')
screen=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(screen)

def pid(value):
    if value is None or value=='':return None
    if isinstance(value,(float,int,np.integer,np.floating)):
        if not np.isfinite(value) or value!=int(value):raise ValueError(f'Invalid PID {value}')
        value=str(int(value))
    else:value=str(value).replace('-','').strip()
    if not value or int(value)==0:return None
    if not value.isdigit() or len(value)>9:raise ValueError(f'Invalid PID {value}')
    return value.zfill(9)

def region(value):
    value=(value or '').lower().replace('regional district of ','').replace(' regional district','').strip()
    return {'nrrm':'northern rockies','northern rockies regional municipality':'northern rockies','fraser fort george':'fraser-fort george'}.get(value,value)

def overlap_detail(geom,trees):
    pieces=[];names=[]
    for name,tree in trees.items():
        indices=tree.query(geom,predicate='intersects')
        if len(indices):
            names.append(name)
            pieces.extend(shapely.intersection(geom,tree.geometries[indices]))
    area=float(shapely.area(shapely.union_all(pieces))) if pieces else 0.0
    return area,area/float(shapely.area(geom)) if shapely.area(geom)>0 else None,';'.join(names)

def main():
    cache=CACHE/'ubc-published-geometry.json.gz'
    with gzip.open(cache,'rt') as f:reference=json.load(f)
    rows=[f['properties'] for f in reference['features']]
    assert len(rows)==len({r['OBJECTID'] for r in rows})==reference['metadata']['count']
    pids=[pid(r['PID_NUMBER']) or pid(r['PID_Formatted']) for r in rows]
    published,invalid=screen.predicate_geometries(np.array([shape(f['geometry']) for f in reference['features']],dtype=object))
    path='/vsizip/'+str(ROOT/'source/polygons/pmbc_parcel_poly_sv.zip')+'/pmbc_parcel_poly_sv.gdb'
    fields=['PMBC_PP_SYSID','PID','OWNER_TYPE','PARCEL_CLASS','PLAN_NUMBER','WHEN_UPDATED','REGIONAL_DISTRICT','PARCEL_STATUS','FEATURE_AREA_SQM']
    print('Reading current parcel attributes',flush=True)
    meta,fids,_,values=read(path,columns=fields,read_geometry=False,return_fids=True)
    attrs=dict(zip(meta['fields'],values));current_pids=[pid(v) for v in attrs['PID']]
    by_pid=defaultdict(list)
    for i,p in enumerate(current_pids):
        if p:by_pid[p].append(i)
    public_decisions=defaultdict(list);retained_ids=set();decision_by_id={}
    with gzip.open(CACHE/'parcel-decisions.csv.gz','rt') as f:
        for d in csv.DictReader(f):
            key=int(d['PMBC_PP_SYSID']);decision_by_id[key]=d
            if d['retained']=='1':retained_ids.add(key)
            if pid(d['PID']):public_decisions[pid(d['PID'])].append(d)
    selected_indices=sorted({i for p in set(pids) for i in by_pid.get(p,[])})
    print(f'Reading {len(selected_indices):,} matching source geometries',flush=True)
    gm,gfid,wkb,gdata=read(path,fids=fids[selected_indices],columns=['PID'],return_fids=True)
    geo_by_pid=defaultdict(list)
    current_geoms,invalid_current=screen.predicate_geometries(shapely.from_wkb(wkb))
    for p,g in zip(gdata[0],current_geoms):geo_by_pid[pid(p)].append(g)
    current_union={p:shapely.union_all(g) for p,g in geo_by_pid.items()}
    masks={}
    for name in ['reserves','provincial_parks','national_parks','conservancies']:
        with gzip.open(CACHE/f'{name}.json.gz','rt') as f:d=json.load(f)
        g,_=screen.predicate_geometries(np.array([shape(f['geometry']) for f in d['data']['features']],dtype=object))
        masks[name]=shapely.STRtree(g)
    baseline={k:v for k,v in masks.items() if k!='conservancies'}
    geometry_metrics=[];exceptions=[];class_counts=Counter();owner_changes=Counter();region_changes=Counter()
    published_groups=defaultdict(list)
    for i,p in enumerate(pids):published_groups[p].append(i)
    for i,(r,p,g) in enumerate(zip(rows,pids,published)):
        source=by_pid.get(p,[]);decisions=public_decisions.get(p,[])
        if not source:status='missing_current_pid'
        elif not decisions:status='current_nonpublic_owner'
        elif any(d['retained']=='1' for d in decisions):status='retained'
        else:status='excluded_spatially'
        class_counts[status]+=1
        x={'OBJECTID':r['OBJECTID'],'PID':p,'status':status,'published_owner':r['OwnerType_Clean'],'published_region':r['RD_Name'],
           'published_area_m2':float(shapely.area(g)),'reported_area_m2':r['Area_m2'],'published_use':r['Actual_Use_Derived']}
        if source:
            owners=sorted({str(attrs['OWNER_TYPE'][j]) for j in source});regions=sorted({str(attrs['REGIONAL_DISTRICT'][j]) for j in source})
            x.update(current_owners=';'.join(owners),current_regions=';'.join(regions),current_parcel_classes=';'.join(sorted({str(attrs['PARCEL_CLASS'][j]) for j in source})),
                     latest_current_update=str(max(attrs['WHEN_UPDATED'][source])))
            if r['OwnerType_Clean'].lower() not in [o.lower() for o in owners]:owner_changes[(r['OwnerType_Clean'],';'.join(owners))]+=1
            if region(r['RD_Name']) not in [region(v) for v in regions]:region_changes[(r['RD_Name'],';'.join(regions))]+=1
            local=current_union[p];intersection=float(shapely.area(shapely.intersection(g,local)));union=float(shapely.area(shapely.union(g,local)))
            x['iou']=intersection/union if union else None
            x['published_footprint_covered']=intersection/float(shapely.area(g)) if shapely.area(g) else None
            x['current_area_m2']=float(shapely.area(local))
            geometry_metrics.append(x.copy())
        if status!='retained':
            a,f,n=overlap_detail(g,baseline);x.update(published_overlap_m2=a,published_overlap_fraction=f,published_intersecting_masks=n)
            if source:
                a,f,n=overlap_detail(current_union[p],baseline);x.update(current_overlap_m2=a,current_overlap_fraction=f,current_intersecting_masks=n)
            exceptions.append(x)
    print('Comparing duplicate footprints and exclusion sensitivity',flush=True)
    repeated={p:idx for p,idx in published_groups.items() if len(idx)>1}
    repeated_same=0;different=0;multiroll=0
    for p,idx in repeated.items():
        if len({shapely.to_wkb(shapely.normalize(published[i])) for i in idx})==1:repeated_same+=1
        else:different+=1
        if len({(rows[i]['JURISDICTION_CODE'],rows[i]['ROLL_NUMBER']) for i in idx})>1:multiroll+=1
    combos=Counter((p,r['JURISDICTION_CODE'],r['ROLL_NUMBER']) for p,r in zip(pids,rows))
    area=np.array([r['Area_m2'] if r['Area_m2'] is not None else np.nan for r in rows])
    retained_index=[i for i,key in enumerate(attrs['PMBC_PP_SYSID']) if int(key) in retained_ids]
    retained_area=attrs['FEATURE_AREA_SQM'][retained_index]
    assert len(retained_index)==len(retained_ids)
    size_counts=lambda a:{'below_100m2':int((a<100).sum()),'100m2_to_2ha':int(((a>=100)&(a<=20000)).sum()),'above_2ha':int((a>20000).sum()),'missing_area':int(np.isnan(a).sum())}
    spatial=[x for x in exceptions if x['status']=='excluded_spatially']
    pct=np.array([x['current_overlap_fraction'] for x in spatial]);overlap=np.array([x['current_overlap_m2'] for x in spatial])
    ious=np.array([x['iou'] for x in geometry_metrics]);pubcoverage=np.array([x['published_footprint_covered'] for x in geometry_metrics])
    conservancy_hits,_=screen.intersect_masks(published,masks['conservancies'].geometries)
    summary={
        'sources':{'published':reference['metadata'],'publishedCacheSha256':hashlib.sha256(cache.read_bytes()).hexdigest(),
                   'parcelManifest':json.loads((ROOT/'output/polygons-manifest.json').read_text()),'screenSummarySha256':hashlib.sha256((OUT/'summary.json').read_bytes()).hexdigest()},
        'published_records':len(rows),'published_distinct_pids':len(published_groups),'classification':dict(class_counts),
        'duplicate_pids':{'keys_with_multiple_rows':len(repeated),'extra_rows_beyond_unique_pid':len(rows)-len(published_groups),
            'keys_with_exactly_same_normalized_geometry':repeated_same,'keys_with_different_geometries':different,'keys_with_multiple_jurisdiction_roll_pairs':multiroll,
            'extra_rows_beyond_pid_jurisdiction_roll_key':sum(n-1 for n in combos.values()),'max_rows_per_pid':max(map(len,published_groups.values()))},
        'geometry_comparison':{'compared_records':len(geometry_metrics),'invalid_published_repaired_for_audit':invalid,'invalid_current_repaired_for_audit':invalid_current,
            'iou_at_least_0_999':int((ious>=.999).sum()),'iou_at_least_0_99':int((ious>=.99).sum()),'iou_below_0_95':int((ious<.95).sum()),'iou_below_0_5':int((ious<.5).sum()),
            'median_iou':float(np.median(ious)),'minimum_iou':float(ious.min()),'published_area_covered_at_least_99pct':int((pubcoverage>=.99).sum())},
        'spatial_exceptions':{'records':len(spatial),'current_overlap_under_1m2':int((overlap<1).sum()),'current_overlap_under_0_1pct':int((pct<.001).sum()),
            'current_overlap_under_1pct':int((pct<.01).sum()),'current_overlap_at_least_50pct':int((pct>=.5).sum()),
            'published_geometry_has_no_current_mask_intersection':sum(not x['published_intersecting_masks'] for x in spatial),
            'median_current_overlap_fraction':float(np.median(pct)),'maximum_current_overlap_fraction':float(pct.max())},
        'ownership_disagreements':[{'published':a,'current':b,'records':n} for (a,b),n in owner_changes.most_common()],
        'regional_disagreements':[{'published':a,'current':b,'records':n} for (a,b),n in region_changes.most_common()],
        'published_reported_area':size_counts(area),'our_retained_source_area':size_counts(retained_area),
        'our_retained_without_pid':sum(current_pids[i] is None for i in retained_index),
        'published_conservancy_intersections':int(conservancy_hits.sum()),
        'published_actual_use':dict(Counter(r['Actual_Use_Derived'] for r in rows)),
        'interpretation':{'snapshot_comparison':'Different snapshots: January methodology, August published service, September current parcels/masks.',
            'iou':'Intersection area / union area of published footprint and union of current parcel polygons with the same PID. Diagnostic thresholds are not eligibility rules.',
            'overlap':'Union of current reserve/provincial park/national park intersections, divided by whole current parcel footprint; conservancies separate.',
            'area':'Published Area_m2 versus current source FEATURE_AREA_SQM, not a reconstruction of their assessment filters.',
            'ownership':'Conflicting snapshots do not by themselves prove an ownership transfer.',
            'no_rule_change':'Diagnostic audit only; baseline candidate set was not modified.'}}
    (OUT/'audit-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    for name,records in [('audit-exceptions.csv',exceptions),('audit-geometry-comparison.csv',geometry_metrics)]:
        columns=list(dict.fromkeys(k for row in records for k in row))
        with (CACHE/name).open('w',newline='') as f:
            writer=csv.DictWriter(f,fieldnames=columns);writer.writeheader();writer.writerows(records)
    (CACHE/'audit-missing-pids.json').write_text(json.dumps(sorted({r['PID'] for r in exceptions if r['status']=='missing_current_pid'})))
    print(json.dumps({k:v for k,v in summary.items() if k not in ['sources','published_actual_use']},indent=2),flush=True)

if __name__=='__main__':main()
