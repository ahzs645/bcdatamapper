#!/usr/bin/env python3
"""Validate every referenced immutable blob and report coverage, without network."""
import gzip
import json
import math
from pathlib import Path
from normalize import ROOT, encoded, digest, release_agreement
from calculations import audit_family


def validate(root):
    manifest=json.loads((root/'latest.json').read_text()); unhashed=dict(manifest); unhashed.pop('releaseId')
    assert digest(encoded(unhashed))==manifest['releaseId'], 'Manifest checksum mismatch'
    assert (root/'releases'/(manifest['releaseId']+'.json')).read_bytes()==encoded(manifest), 'Release pointer mismatch'
    def read(ref):
        path=Path(ref['path'])
        assert path.parts[0]=='blobs' and path.name==ref['sha256']+'.json.gz'
        payload=gzip.decompress((root/path).read_bytes()); assert digest(payload)==ref['sha256'], 'Blob checksum mismatch'
        return json.loads(payload)
    summary={'releaseId':manifest['releaseId'],'datasets':{},'boundaries':{},'gaps':manifest['gaps']}
    families_by_dataset={d['id']:{code:read(ref) for code,ref in d['families'].items()} for d in manifest['datasets']}
    for dataset in manifest['datasets']:
        measures={m['id']:m for m in dataset['measures']}; counts={}
        for code,family in families_by_dataset[dataset['id']].items():
            ids=set(); total=reported=missing=0; statuses={}; by_wave={}
            if 'calculationAudit' in dataset:
                original=encoded(family)
                assert audit_family(family)==dataset['calculationAudit'][code], 'Calculation summary mismatch'
                assert encoded(family)==original, 'Calculation values mismatch'
            for region in family['regions']:
                assert region['id'].startswith(code+'_') and region['id'] not in ids, 'Duplicate or mismatched region'; ids.add(region['id'])
                keys=set()
                for o in region['observations']:
                    key=(o['wave'],o['measure']); assert key not in keys, f'Duplicate measure: {region["id"]}/{key}'; keys.add(key)
                    assert o['wave'] in dataset['waves']; unit=measures[o['measure']]['unit']; v=o['value']; total+=1
                    statuses[o['status']]=statuses.get(o['status'],0)+1
                    if v is None: assert o['status']!='reported'; missing+=1; continue
                    assert isinstance(v,(float,int)) and math.isfinite(v)
                    assert o['status']=='reported'; reported+=1
                    by_wave[o['wave']]=by_wave.get(o['wave'],0)+1
                    if unit=='percent': assert 0<=v<=100, f'Invalid percent: {region["id"]}/{key}/{v}'
                    if unit=='count': assert v>=0 and int(v)==v, f'Invalid count: {region["id"]}/{key}/{v}'
            counts[code]={'regions':len(ids),'observations':total,'reported':reported,'missing':missing,'statuses':statuses,'reportedByWave':by_wave}
        summary['datasets'][dataset['id']]=counts
    summary['calculationAudits']={d['id']:d.get('calculationAudit') for d in manifest['datasets']}
    summary['boundaryStorage']=manifest.get('boundaryStorage')
    if manifest.get('boundaryStorage'):
        assert manifest['boundaryStorage']['uniqueGeometryAssets']==len({b['sha256'] for b in manifest['boundaries']})
        assert manifest['boundaryStorage']['snapshots']==len(manifest['boundaries'])
    for boundary in manifest['boundaries']:
        geometry=read(boundary); ids=set()
        for f in geometry['features']:
            rid=f['properties']['regionId']; assert rid not in ids and rid.startswith(boundary['family']+'_'); ids.add(rid)
            g=f['geometry']; assert g['type'] in ('Polygon','MultiPolygon')
            polygons=[g['coordinates']] if g['type']=='Polygon' else g['coordinates']
            assert polygons and all(polygons), f'Empty geometry: {rid}'
            for polygon in polygons:
                for ring in polygon:
                    assert len(ring)>=4 and ring[0]==ring[-1], f'Unclosed ring: {rid}'
                    assert all(-150<=p[0]<=-110 and 45<=p[1]<=65 for p in ring), f'Coordinates outside BC / reversed axes: {rid}'
        if 'regionIds' in boundary:
            # A shared polygon library: the wave's membership selects its features.
            assert boundary['regionIds']==sorted(set(boundary['regionIds'])) and set(boundary['regionIds'])<=ids, f'Wave membership outside library: {boundary["id"]}'
            ids=set(boundary['regionIds'])
        assert len(ids)==boundary['features']
        summary['boundaries'][boundary['id']]={'features':len(ids),'joinPolicy':boundary['joinPolicy'],'coverage':boundary.get('coverage')}
    by_id={b['id']:b for b in manifest['boundaries']}
    if manifest.get('crosswalk'):
        crosswalk=read(manifest['crosswalk'])
        for code,family in crosswalk['families'].items():
            reference=by_id[family['reference']]; wave_maps=[b for b in manifest['boundaries'] if b['family']==code and b['joinPolicy']=='edi_wave']
            assert family['referenceSha256']==reference['sha256'] and all(b['sha256']==family['publisherSha256'] for b in wave_maps), f'Crosswalk geometry mismatch: {code}'
            publisher_ids={rid for b in wave_maps for rid in b['regionIds']}; reference_ids=set(reference['regionNames'])
            assert set(family['regions'])==publisher_ids and set(family['referenceOnly'])==reference_ids-publisher_ids, f'Crosswalk coverage mismatch: {code}'
            threshold=crosswalk['thresholds']['sameAreaIoU']
            for rid,entry in family['regions'].items():
                assert (entry['status']=='same_area')==(rid in reference_ids and entry['iou']>=threshold), f'Crosswalk status mismatch: {rid}'
            assert manifest['crosswalk']['families'][code]['counts']==family['counts']
        summary['crosswalk']={code:f['counts'] for code,f in crosswalk['families'].items()}
    for dataset in manifest['datasets']:
        join=dataset.get('mapJoin')
        if not join or join['policy']!='inferred_by_region_id': continue
        dashboard=next(d for d in manifest['datasets'] if d['id']==join['boundaryRelease'])
        units={m['id']:m['unit'] for d in manifest['datasets'] for m in d['measures']}
        for code,entry in join['families'].items():
            agreement=release_agreement(families_by_dataset[dataset['id']][code],families_by_dataset[dashboard['id']].get(code,{}),units)
            assert {k:entry[k] for k in agreement}==agreement, f'Join evidence mismatch: {code}'
            assert entry['eligible']==(agreement['overlappingValues']>0 and agreement['disagreements']==0)
        summary['workbookMapJoin']={code:{k:e[k] for k in ('eligible','overlappingValues','disagreements')} for code,e in join['families'].items()}
    return summary

if __name__=='__main__':
    summary=validate(ROOT/'cache/products'); (ROOT/'cache/products/validation.json').write_text(json.dumps(summary,indent=2)+'\n')
    print(json.dumps(summary,indent=2))
