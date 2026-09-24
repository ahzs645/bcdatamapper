#!/usr/bin/env python3
"""Build immutable local EDI review releases. Python standard library only."""
import argparse
import gzip
import hashlib
import html
import json
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from calculations import audit_family, TOLERANCE_PP

ROOT = Path(__file__).resolve().parent
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
SHEETS = {'Neighbourhood':'NH', 'School district':'GEOSD', 'Health Authority':'HA', 'Health Service Delivery Area':'HSDA', 'Local Health Area':'LHA', 'CHSA':'CHSA', 'MCFD':'MCFD', 'Service Delivery Area':'SDA', 'Local Service Area':'LSA'}
LABELS = {'GEOSD':'School districts', 'NH':'HELP neighbourhoods', 'HA':'Health authorities', 'HSDA':'Health service delivery areas', 'LHA':'Local health areas', 'CHSA':'Community health service areas', 'MCFD':'MCFD regions (legacy)', 'SDA':'MCFD service delivery areas (legacy)', 'LSA':'MCFD local service areas (legacy)', 'PROVINCE':'Province'}

def normal_name(value):
    return ' '.join(html.unescape(str(value)).split())


def series_values(value):
    # Plotly may unbox a one-point customdata vector. Zero is still a value.
    return value if isinstance(value,list) else ([] if value is None else [value])


def encoded(data):
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def boundary_geometry(data):
    """Keep wave/source provenance in the manifest, so identical maps share a blob.

    Coordinates are unchanged. Sorting feature IDs is not a spatial transform;
    different coordinates or membership always produce a different asset.
    """
    return {'type':'FeatureCollection', 'features':sorted([
        {'type':'Feature', 'id':f['properties']['regionId'], 'geometry':f['geometry'],
         'properties':{'regionId':f['properties']['regionId']}}
        for f in data['features']
    ], key=lambda f:f['id'])}


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_bytes(encoded(data))
    temporary.replace(path)


def workbook(path):
    with zipfile.ZipFile(path) as z:
        strings = [''.join(si.itertext()) for si in ET.fromstring(z.read('xl/sharedStrings.xml'))]
        rels = {r.attrib['Id']: r.attrib['Target'] for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
        result = {}
        for sheet in ET.fromstring(z.read('xl/workbook.xml')).find('m:sheets', NS):
            target = rels[sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
            rows = []
            for row in ET.fromstring(z.read('xl/' + target.lstrip('/').removeprefix('xl/'))).find('m:sheetData', NS):
                cells = {}
                for cell in row:
                    col = 0
                    for letter in re.match('[A-Z]+', cell.attrib['r'])[0]: col = col * 26 + ord(letter) - 64
                    value = cell.find('m:v', NS)
                    raw = value.text if value is not None else None
                    if cell.attrib.get('t') == 's' and raw is not None: raw = strings[int(raw)]
                    elif raw is not None and cell.attrib.get('t') not in ('str', 'e'):
                        raw = float(raw); raw = int(raw) if raw.is_integer() else raw
                    cells[col - 1] = raw
                rows.append(cells)
            result[sheet.attrib['name']] = rows
        return result


def metric(label):
    text = ' '.join(label.lower().split())
    unit = 'percent' if '%' in text else 'count'
    prefix = 'pct' if unit == 'percent' else 'count'
    scale = next((s for s in ['physical','social','emotional','language','communication'] if s in text), 'overall')
    multiple = re.search(r'vulnerable on (\d) scale', text)
    if multiple: key = f'{prefix}_multiple_{multiple[1]}'
    elif 'vulnerable' in text: key = f'{prefix}_{scale}_vulnerable'
    elif 'at risk' in text: key = f'{prefix}_{scale}_at_risk'
    elif 'in flux' in text: key = f'{prefix}_overall_in_flux'
    elif 'on track' in text: key = f'{prefix}_{scale}_on_track'
    else: key = prefix + '_' + re.sub('[^a-z0-9]+', '_', text).strip('_')
    return key, {'id':key, 'label':label.strip(), 'unit':unit}


def observation(wave, key, value):
    # The publisher's blank cell does not distinguish unavailable from suppressed.
    numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
    return {'wave':wave, 'measure':key, 'value':value if numeric else None,
            'status':'reported' if numeric else ('not_reported_or_suppressed' if value is None else 'source_token'),
            **({'raw':value} if value is not None and not numeric else {})}


def normalize_workbook(path):
    sheets = workbook(path); families = {}; measures = {}
    for name, code in SHEETS.items():
        rows = sheets[name]
        index = next(i for i,r in enumerate(rows) if str(r.get(0,'')).strip() == 'Code')
        columns = {}; label = None
        for col, wave in sorted(rows[index].items()):
            if col < 2: continue
            label = rows[index-1].get(col) or label
            if not label or not re.fullmatch(r'w[2-8]', str(wave).strip()): raise ValueError(f'Unexpected header {name}/{col}')
            key, definition = metric(label); measures[key] = definition
            columns[col] = (int(str(wave).strip()[1:]), key)
        regions = []
        for row in rows[index+1:]:
            if row.get(0) is None: continue
            rid = f'{code}_{row[0]}'
            regions.append({'id':rid, 'name':row[1], 'observations':[observation(w,k,row.get(c)) for c,(w,k) in columns.items()]})
        families[code] = {'regions':regions}
    rows = sheets['Province']; index = next(i for i,r in enumerate(rows) if r.get(0) == 'Wave')
    obs = []
    for row in rows[index+1:]:
        found = re.match(r'Wave ([2-8])', str(row.get(0,'')))
        if not found: continue
        for col, label in rows[index].items():
            if col == 0 or not label: continue
            key, definition = metric(label); measures[key] = definition
            # Province's source header says 0 scales; preserve it as written,
            # do not silently "correct" it to 1 based on the neighbouring count.
            obs.append(observation(int(found[1]),key,row.get(col)))
    families['PROVINCE'] = {'regions':[{'id':'PROVINCE_BC','name':'British Columbia','observations':obs}]}
    return families, measures, '\n'.join(str(v) for row in sheets['Notes'] for v in row.values() if v is not None)


def dashboard_family(paths):
    families = {}; measures = {}
    for path in sorted(paths):
        r = json.loads(path.read_text())
        if r.get('collectorVersion') != 2: continue
        obs = []; changes = {}; subchanges = {}
        for scale in r['scales']:
            s = scale['scale']; changes[s] = scale['meaningfulChange']; subchanges[s] = scale['subscaleChange']
            name = normal_name(r['name'])
            outcomes = [t for t in scale['outcomes'] if normal_name(t['name']) == name]
            traces = [t for t in scale['vulnerability'] if (name in [normal_name(m) for m in series_values(t.get('meta'))] or normal_name(t['name']) == name) and t.get('lineColor') != 'rgba(190,190,190,1)']
            # A single-neighbourhood district can have two identical, same-name
            # traces (area and parent). Only collapse exactly identical numbers.
            traces = list({encoded([t.get('x'),t.get('y'),series_values(t.get('counts'))]):t for t in traces}.values())
            if traces and outcomes:
                outcome = outcomes[0]; index = next((i for i,label in enumerate(outcome['y']) if label.strip() == 'Vulnerable'),None)
                if index is not None:
                    percent = outcome['x'][index]; count = (series_values(outcome.get('counts')) or [None]*len(outcome['x']))[index]
                    traces = [t for t in traces if r['requestedWave'] in t['x'] and t['y'][t['x'].index(r['requestedWave'])] == percent and (series_values(t.get('counts')) or [None]*len(t['x']))[t['x'].index(r['requestedWave'])] == count]
                    if not traces: raise ValueError(f'Outcome and trend disagree: {r["id"]}/{s}')
            if len(traces) > 1: raise ValueError(f'Ambiguous area trend: {r["id"]}/{s}')
            if outcomes and not traces: raise ValueError(f'Outcome has no selected-area trend: {r["id"]}/{s}')
            if len(traces) == 1 and len(scale['vulnerability']) == 1 and not outcomes and 'lineColor' not in traces[0]:
                raise ValueError(f'Recapture {r["id"]}: unnamed role for same-name comparison trace')
            # Suppressed areas can display only a parent's comparison trace.
            # No selected-area trace means missing; never substitute the parent.
            trace = traces[0] if traces else {'x':[], 'y':[]}
            for prefix in ['pct','count']:
                key = f'{prefix}_{s}_vulnerable'
                measures[key] = {'id':key,'label':f'{s.title()} vulnerable','unit':'percent' if prefix == 'pct' else 'count'}
            for index, wave in enumerate(trace['x']):
                if wave is None: continue # Plotly separator / unreported period
                for prefix, values in [('pct', trace['y']), ('count', series_values(trace.get('counts')))]:
                    key = f'{prefix}_{s}_vulnerable'
                    measures[key] = {'id':key,'label':f'{s.title()} vulnerable', 'unit':'percent' if prefix == 'pct' else 'count'}
                    obs.append(observation(int(wave),key,values[index] if index < len(values) else None))
            for t in outcomes:
                for index, label in enumerate(t['y']):
                    suffix = re.sub('[^a-z]+','_',label.lower()).strip('_')
                    if suffix == 'vulnerable': continue # trend supplies it once
                    for prefix, values in [('pct',t['x']),('count',series_values(t.get('counts')))]:
                        key = f'{prefix}_{s}_{suffix}'; measures[key] = {'id':key,'label':f'{s.title()} {label.strip()}', 'unit':'percent' if prefix == 'pct' else 'count'}
                        obs.append(observation(r['requestedWave'],key,values[index] if index < len(values) else None))
            for t in scale['subscales']:
                key = f'score_{s}_' + re.sub('[^a-z0-9]+','_',t['name'].lower()).strip('_')
                measures[key] = {'id':key,'label':t['name'],'unit':'standardized_score'}
                for w,v in zip(t['x'],t['y']):
                    if w is not None: obs.append(observation(int(w),key,v))
        for t in r['multipleVulnerabilities']:
            match = re.fullmatch(r'(\d) Scales?', t['name'])
            if not match: raise ValueError(f'Unexpected multiple vulnerability label: {t["name"]}')
            for index, w in enumerate(t['x']):
                if w is None: continue
                for prefix, values in [('pct',t['y']),('count',series_values(t.get('counts')))]:
                    key = f'{prefix}_multiple_{match[1]}'
                    measures[key] = {'id':key,'label':f'Vulnerable on {t["name"].lower()}', 'unit':'percent' if prefix == 'pct' else 'count'}
                    obs.append(observation(int(w),key,values[index] if index < len(values) else None))
        families.setdefault(r['boundary'], {'regions':[]})['regions'].append({'id':r['id'],'name':r['name'],'observations':obs,'detailWave':r['requestedWave'],'detailWaveSelection':r.get('detailWaveSelection','latest_selectable_wave'),'disabledWaves':r.get('disabledWaves',[]),'meaningfulChange':changes,'subscaleChange':subchanges,'demographics':r['demographics'],'participation':r['participation']})
    # Distinguish collector scope from source gaps. Earlier outcome bars were
    # not requested; their absence must never be described as suppression.
    for code, family in families.items():
        for region in family['regions']:
            # The publisher sums empty pre-CHSA periods to zero in its ALL
            # multiple-vulnerability chart. Keep that source value for audit,
            # but do not present it as an observation before reporting began.
            if region['id'] == 'CHSA_ALL':
                for o in region['observations']:
                    if o['wave'] < 7 and '_multiple_' in o['measure'] and o['value'] == 0:
                        o.update(value=None,sourceValue=0,status='outside_reporting_period')
            seen = {(o['wave'],o['measure']) for o in region['observations']}
            for wave in range(2,10):
                for key in measures:
                    if (wave,key) in seen: continue
                    outcome = key.endswith(('_on_track','_at_risk','_in_flux'))
                    status = 'not_collected_for_wave' if outcome and wave != region['detailWave'] else 'not_reported_in_chart'
                    if wave in region['disabledWaves']: status = 'publisher_disabled'
                    if code == 'CHSA' and wave < 7: status = 'outside_reporting_period'
                    region['observations'].append({'wave':wave,'measure':key,'value':None,'status':status})
    return families, measures


def wave_boundary_paths(capture):
    paths = list((capture/'wave-boundaries').glob('*.geojson'))
    paths += [p for p in (capture/'boundaries').glob('*.geojson') if not (capture/'wave-boundaries'/(p.stem+'-9.geojson')).exists()]
    return sorted(paths)


def dashboard_library(capture, current=None):
    """One publisher polygon per region ID, with each wave recorded as membership.

    The dashboard redraws a whole map per wave, but a region's polygon has not
    changed between waves; waves differ only in which IDs are displayed. If a
    future capture does redraw an ID, fail rather than pick one of the shapes.
    """
    families = {}
    for p in wave_boundary_paths(capture):
        d = json.loads(p.read_text()); code = p.stem.split('-')[0]
        wave = d.get('metadata',{}).get('displayedWave',9)
        family = families.setdefault(code, {'geometry':{}, 'names':{}, 'waves':{}, 'metadata':{}})
        resolved = {r['id']:r['name'] for r in (current or {}).get(code,{}).get('regions',[])}
        for f in d['features']:
            rid = f['properties']['regionId']; name = f['properties'].get('regionName', rid)
            if name == rid and rid in resolved: name = resolved[rid]
            known = family['geometry'].get(rid)
            if known is not None and encoded(known) != encoded(f['geometry']):
                raise ValueError(f'{rid} is drawn differently in {p.name}; wave maps can no longer share one polygon library')
            family['geometry'][rid] = f['geometry']; family['names'].setdefault(wave, {})[rid] = name
        family['waves'][wave] = sorted({f['properties']['regionId'] for f in d['features']})
        family['metadata'][wave] = d.get('metadata')
    for family in families.values():
        family['collection'] = {'type':'FeatureCollection', 'features':[
            {'type':'Feature', 'geometry':g, 'properties':{'regionId':rid}} for rid,g in family['geometry'].items()]}
    return families


def current_official_boundaries(capture_id):
    """Yield current official WFS snapshots with EDI region IDs, after checking their hash."""
    for p in sorted((ROOT/'cache/current-boundaries'/capture_id).glob('*.source.json')):
        metadata = json.loads(p.read_text()); code = metadata['family']
        payload = p.with_name(code+'.geojson').read_bytes()
        if digest(payload) != metadata['sha256']: raise ValueError('Current boundary source hash mismatch')
        d = json.loads(payload)
        for f in d['features']:
            props = f['properties']; rid = f'{code}_{props[metadata["codeProperty"]]}'
            f['id'] = rid; f['properties'] = {'regionId':rid,'regionName':props[metadata['nameProperty']]}
        yield code, metadata, d


def release_agreement(workbook_family, dashboard_family, units):
    """Compare every value both releases publish for the same area, wave and measure.

    This is the evidence for placing workbook values on the dashboard's polygons:
    the dashboard presents those same numbers on those polygons. Percentages are
    displayed to one decimal on the dashboard; counts must match exactly.
    """
    dashboard = {r['id']:{(o['wave'],o['measure']):o['value'] for o in r['observations'] if o['value'] is not None} for r in dashboard_family.get('regions',[])}
    overlapping = 0; disagreements = []
    for region in workbook_family.get('regions',[]):
        other = dashboard.get(region['id'])
        if other is None: continue
        for o in region['observations']:
            value = other.get((o['wave'],o['measure']))
            if o['value'] is None or value is None: continue
            overlapping += 1
            tolerance = TOLERANCE_PP if units.get(o['measure']) == 'percent' else 0
            if abs(o['value'] - value) > tolerance: disagreements.append([region['id'],o['wave'],o['measure'],o['value'],value])
    return {'overlappingValues':overlapping, 'disagreements':len(disagreements), 'examples':disagreements[:5]}


def workbook_map_join(historical, current, library, units, boundary_release):
    families = {}
    for code, family in historical.items():
        if code not in library: continue
        agreement = release_agreement(family, current.get(code,{}), units)
        members = {w:set(ids) for w,ids in library[code]['waves'].items()}
        # A workbook value is mappable only where the dashboard drew that ID in that wave.
        unmapped = sorted({f'{r["id"]}@{o["wave"]}' for r in family['regions'] for o in r['observations']
                           if o['value'] is not None and r['id'] not in members.get(o['wave'],set())})
        families[code] = {**agreement, 'eligible':agreement['overlappingValues'] > 0 and agreement['disagreements'] == 0,
                          'valuesWithoutWaveGeometry':unmapped}
    return {'policy':'inferred_by_region_id', 'boundaryRelease':boundary_release, 'families':families,
            'basis':'The workbook does not ship geometry. Its values are drawn on the dashboard polygon with the same area code and wave only for families where every value published by both releases agrees. UBC does not state this join; it is an inference and is labelled as one.'}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--capture', required=True); args = parser.parse_args()
    if not re.fullmatch('[a-zA-Z0-9_-]+',args.capture): raise ValueError('Invalid capture')
    capture = ROOT / 'cache/captures' / args.capture
    output = ROOT / 'cache/products'; blobs = output / 'blobs'
    def blob(data):
        payload = encoded(data); sha = digest(payload); path = blobs / f'{sha}.json.gz'
        if path.exists():
            if gzip.decompress(path.read_bytes()) != payload: raise ValueError('Immutable blob mismatch')
        else:
            path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(gzip.compress(payload,mtime=0))
        return {'path':f'blobs/{sha}.json.gz', 'sha256':sha}
    def boundary_blob(data):
        return {**blob(boundary_geometry(data)),
                'regionNames':{f['properties']['regionId']:f['properties'].get('regionName',f['properties']['regionId']) for f in data['features']},
                'sourceGeometryMetadata':data.get('metadata')}
    wb = ROOT.parent / 'early-learning-boundaries/cache/EDI_data_library_wave_2_to_8.xlsx'
    historical, historic_measures, notes = normalize_workbook(wb)
    historical_audit = {code:audit_family(family) for code,family in historical.items()}
    datasets = [{'id':'workbook-' + digest(wb.read_bytes())[:16], 'label':'Published workbook · Waves 2–8', 'source':'https://earlylearning.ubc.ca/resources/mediatype/data-library/', 'sourceSha256':digest(wb.read_bytes()), 'waves':list(range(2,9)), 'measures':list(historic_measures.values()), 'notes':notes, 'families':{c:blob(d) for c,d in historical.items()}}]
    current, current_measures = dashboard_family((capture/'regions').glob('*.json'))
    current_audit = {code:audit_family(family) for code,family in current.items()}
    inventory = json.loads((capture/'regions.json').read_text())
    captured_ids = {r['id'] for family in current.values() for r in family['regions']}
    missing = sorted({r['id'] for r in inventory} - captured_ids)
    capture_manifest = {'complete':not missing, 'completed':len(captured_ids), 'inventoryRegions':len(inventory), 'missingRegions':missing}
    if current:
        datasets.append({'id':'dashboard-' + args.capture, 'label':f'Dashboard capture · {args.capture}', 'source':'https://dashboard.earlylearning.ubc.ca/', 'waves':list(range(2,10)), 'measures':list(current_measures.values()), 'families':{c:blob(d) for c,d in current.items()}, 'capture':capture_manifest, 'notes':'Trends retain this dashboard release; older waves may differ between releases. Outcomes, demographics, participation, and change descriptions use the captured detailWave, normally 9. Publisher-disabled waves are retained separately. Map-only areas use their latest verified map wave when current details cannot be verified; this is recorded as detailWaveSelection. Null is not zero. Standardized scores are not percentages. Multiple-vulnerability labels are preserved. The CHSA all-area chart emits 50 zero cells before CHSA reporting begins at Wave 7; these are retained as sourceValue but displayed as outside_reporting_period.'})
    datasets[0]['calculationAudit'] = historical_audit
    if current: datasets[-1]['calculationAudit'] = current_audit
    boundaries = []
    library = dashboard_library(capture, current)
    library_refs = {code:blob(boundary_geometry(family['collection'])) for code,family in library.items()}
    for code, family in sorted(library.items()):
        for displayed_wave, members in sorted(family['waves'].items()):
            ids = set(members); coverage = {}
            for ds, results in [('workbook',historical.get(code,{})),('dashboard',current.get(code,{}))]:
                expected = {r['id'] for r in results.get('regions',[]) if not r['id'].endswith('_ALL')}
                coverage[ds] = {'missingGeometry':sorted(expected-ids), 'geometryWithoutResults':sorted(ids-expected)}
            boundaries.append({'id':f'dashboard-{args.capture}-{code}-{displayed_wave}', 'family':code, 'reportedWaves':[displayed_wave], 'label':f'EDI dashboard · Wave {displayed_wave} · captured {args.capture}', 'edition':None, 'retrievedAt':args.capture, 'source':'https://dashboard.earlylearning.ubc.ca/', 'resolution':'Publisher geometry displayed for this wave; administrative effective date unknown', 'joinPolicy':'edi_wave', 'coverage':coverage, 'features':len(ids), 'regionIds':members, **library_refs[code], 'regionNames':family['names'][displayed_wave], 'sourceGeometryMetadata':family['metadata'][displayed_wave]})
    health = ROOT.parent / 'boundaries/output/BCMoH'
    for code, filename, prop in [('HA','health_authorities','HLTH_AUTHORITY'),('HSDA','health_service_delivery_areas','HLTH_SERVICE_DLVR_AREA'),('LHA','local_health_areas','LOCAL_HLTH_AREA'),('CHSA','community_health_service_areas','CMNTY_HLTH_SERV_AREA')]:
        p = health / (filename+'.json'); d = json.loads(p.read_text())
        for f in d['features']:
            properties = f['properties']; rid = f'{code}_{properties[prop+"_CODE"]}'
            f['id'] = rid; f['properties'] = {'regionId':rid,'regionName':properties[prop+'_NAME']}
        boundaries.append({'id':f'local-{code}-'+digest(p.read_bytes())[:12], 'family':code, 'label':f'Newer local administrative snapshot · {len(d["features"])} areas', 'edition':None, 'retrievedAt':None, 'source':'https://catalogue.data.gov.bc.ca/', 'sourceSha256':digest(p.read_bytes()), 'resolution':'Existing DataBC snapshot; effective edition and retrieval date not established', 'joinPolicy':'reference_only', 'features':len(d['features']), **boundary_blob(d)})
    p = ROOT.parent / 'early-learning-boundaries/output/BCSchoolDistricts/school_districts.geojson'; d = json.loads(p.read_text())
    boundaries.append({'id':'official-GEOSD-'+digest(p.read_bytes())[:12], 'family':'GEOSD','label':'Official school-district snapshot · 59 areas','edition':None,'retrievedAt':None,'source':d.get('metadata',{}).get('catalogueUrl'),'resolution':d.get('metadata',{}),'joinPolicy':'reference_only','features':len(d['features']),**boundary_blob(d)})
    for code, filename in [('NH','help_neighbourhoods'),('MCFD','mcfd_regions'),('SDA','mcfd_service_delivery_areas'),('LSA','mcfd_local_service_areas')]:
        p = ROOT.parent/'early-learning-boundaries/cache'/(filename+'.geojson')
        if not p.exists(): continue
        d = json.loads(p.read_text())
        for f in d['features']:
            props = f['properties']; rid = f'{code}_{props["regionCode"]}'
            f['id'] = rid; props['regionId'] = rid
        boundaries.append({'id':f'archive-{code}-'+digest(p.read_bytes())[:12], 'family':code,'label':f'Existing {"HELP library" if code == "NH" else "legacy MCFD"} archive · {len(d["features"])} areas','edition':None,'retrievedAt':None,'source':'https://earlylearning.ubc.ca/resources/mediatype/data-library/' if code == 'NH' else 'https://catalogue.data.gov.bc.ca/','sourceSha256':digest(p.read_bytes()),'resolution':d.get('metadata',{}),'joinPolicy':'reference_only','features':len(d['features']),**boundary_blob(d)})
    for code, metadata, d in current_official_boundaries(args.capture):
        boundaries.append({'id':f'current-{args.capture}-{code}', 'family':code,'label':f'Current official WFS · retrieved {args.capture}', 'edition':metadata['effectiveEdition'],'editionEvidenceUrl':metadata.get('editionEvidenceUrl'),'editionEvidenceSha256':metadata.get('editionEvidenceSha256'),'retrievedAt':metadata['retrievedAt'],'source':metadata['sourceUrl'],'sourceSha256':metadata['sha256'],'resolution':metadata['geometryResolution'],'joinPolicy':'reference_only','features':len(d['features']),**boundary_blob(d)})
    units = {**{m['id']:m['unit'] for m in historic_measures.values()}, **{m['id']:m['unit'] for m in current_measures.values()}}
    if current:
        datasets[-1]['mapJoin'] = {'policy':'captured_wave', 'boundaryRelease':f'dashboard-{args.capture}'}
        datasets[0]['mapJoin'] = workbook_map_join(historical, current, library, units, f'dashboard-{args.capture}')
    crosswalk_path = capture/'crosswalk.json'; crosswalk = None
    if crosswalk_path.exists():
        crosswalk = json.loads(crosswalk_path.read_text()); by_id = {b['id']:b for b in boundaries}
        for code, family in crosswalk['families'].items():
            # A crosswalk computed from other coordinates must not be attached to these.
            if family['publisherSha256'] != library_refs[code]['sha256'] or family['referenceSha256'] != by_id[family['reference']]['sha256']:
                raise ValueError(f'Stale crosswalk for {code}: rerun crosswalk.py --capture {args.capture}')
        summary = {code:{'reference':f['reference'],'referenceSha256':f['referenceSha256'],'publisherSha256':f['publisherSha256'],'counts':f['counts']} for code,f in crosswalk['families'].items()}
        crosswalk = {**blob(crosswalk), 'method':crosswalk['method'], 'thresholds':crosswalk['thresholds'], 'families':summary}
    manifest = {'schemaVersion':2,'redistributable':False,'families':LABELS,'datasets':datasets,'boundaries':boundaries,'gaps':['Current MCFD 7-SDA/44-LSA vectors have not been verified. Available MCFD geography is legacy.','Workbook values are drawn on the dashboard polygon with the same area code and wave only where every value both releases publish agrees. UBC does not state that join; it is labelled as inferred.','Current official polygons show EDI values only where the crosswalk finds the same area as the publisher polygon. Changed and newer areas stay unassigned; New Westminster 2210 is never copied onto 2211–2214.' if crosswalk else 'Current official polygons are reference-only until crosswalk.py has compared them with the publisher polygons.','Workbook blanks conflate suppression and non-reporting; the source does not distinguish them.','Province workbook labels one multiple-vulnerability percentage as 0 scales beside a 1-scale count; both original labels are preserved.']}
    if crosswalk: manifest['crosswalk'] = crosswalk
    def compressed(refs): return sum((output/p).stat().st_size for p in {r['path'] for r in refs})
    manifest['boundaryStorage'] = {'snapshots':len(boundaries), 'uniqueGeometryAssets':len({b['sha256'] for b in boundaries}),
        'compressedBytes':{'results':compressed([ref for d in datasets for ref in d['families'].values()]),
                           'ediWaveGeometry':compressed([b for b in boundaries if b['joinPolicy'] == 'edi_wave']),
                           'referenceGeometry':compressed([b for b in boundaries if b['joinPolicy'] == 'reference_only']),
                           'crosswalk':compressed([crosswalk] if crosswalk else [])},
        'method':'Dashboard wave maps share one polygon per region ID; regionIds records which IDs each wave displays. Other snapshots are stored once per exact coordinates and membership. Names and wave/source metadata are kept in each reference.'}
    release = digest(encoded(manifest)); manifest['releaseId'] = release
    release_path = output / 'releases' / (release+'.json')
    if release_path.exists() and release_path.read_bytes() != encoded(manifest): raise ValueError('Immutable release mismatch')
    save(release_path,manifest); save(output/'latest.json',manifest)
    print(json.dumps({'releaseId':release,'datasets':[(d['id'],len(d['families'])) for d in datasets],'boundaries':len(boundaries),'path':str(output/'latest.json')}))

if __name__ == '__main__': main()
