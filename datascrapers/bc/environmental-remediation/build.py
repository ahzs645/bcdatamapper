"""Normalize the research cache to a deterministic, local-only map product."""
import gzip
import hashlib
import json
import math


def normalize(collection):
    if collection.get('type') != 'FeatureCollection':
        raise ValueError('Expected a FeatureCollection')
    features, seen = [], set()
    for feature in collection['features']:
        properties = feature['properties']
        site_id = properties.get('SITE_ID')
        if not isinstance(site_id, int) or site_id <= 0 or site_id in seen:
            raise ValueError(f'Invalid or duplicate registry site ID: {site_id}')
        seen.add(site_id)
        geometry = feature.get('geometry')
        if not geometry or geometry.get('type') != 'Point':
            raise ValueError(f'Site {site_id}: expected a point')
        coords = geometry['coordinates']
        if len(coords) != 2 or not all(isinstance(n, (int, float)) and math.isfinite(n) for n in coords):
            raise ValueError(f'Site {site_id}: invalid coordinates')
        lon, lat = coords
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise ValueError(f'Site {site_id}: coordinates outside CRS84 ranges')
        props = {'siteId': site_id}
        for target, source in [('name', 'COMMON_NAME'), ('address', 'ADDRESS'),
                               ('description', 'GENERAL_DESCRIPTION'),
                               ('victoriaFile', 'VICTORIA_FILE_NO'), ('regionalFile', 'REGIONAL_FILE_NO')]:
            value = properties.get(source)
            props[target] = str(value).strip() if value is not None else None
        features.append({'type': 'Feature', 'id': site_id, 'geometry': geometry, 'properties': props})
    features.sort(key=lambda f: f['id'])
    return {'type': 'FeatureCollection', 'features': features}


def build_product(cache):
    archive = cache.parent / 'source' / 'environmental-remediation-sites.geojson.gz'
    if archive.exists():
        source = json.loads((archive.parent / 'manifest.json').read_text())
        compressed = archive.read_bytes()
        if hashlib.sha256(compressed).hexdigest() != source['gzipSha256']:
            raise ValueError('Compressed source does not match its manifest SHA-256')
        raw = gzip.decompress(compressed)
    else:
        # Compatibility with the initial research download layout.
        raw = (cache / 'environmental-remediation-sites.geojson').read_bytes()
        source = json.loads((cache / 'manifest.json').read_text())
    if hashlib.sha256(raw).hexdigest() != source['sha256']:
        raise ValueError('Downloaded source does not match its manifest SHA-256')
    product = normalize(json.loads(raw))
    if len(product['features']) != source['featureCount']:
        raise ValueError('Source count does not match manifest')
    payload = (json.dumps(product, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    digest = hashlib.sha256(payload).hexdigest()
    filename = f'sites-{digest}.geojson.gz'
    compressed = gzip.compress(payload, mtime=0)
    cache.mkdir(exist_ok=True)
    (cache / filename).write_bytes(compressed)
    manifest = {'schemaVersion': 1, 'title': 'Environmental Remediation Sites',
                'downloadedAt': source['downloadedAt'], 'featureCount': len(product['features']),
                'resource': filename, 'bytes': len(payload), 'gzipBytes': len(compressed), 'sha256': digest,
                'catalogue': source['catalogue'], 'service': source['service'],
                'license': source['license'], 'licenseUrl': source['licenseUrl'],
                'crs': 'OGC:CRS84', 'geometrySimplified': False,
                'description': 'Registry locations for known and potentially contaminated properties. Not contamination extents or current contamination status.'}
    temporary = cache / 'map-manifest.json.tmp'
    temporary.write_text(json.dumps(manifest, indent=2) + '\n')
    temporary.replace(cache / 'map-manifest.json')
    print(f"Map product: {len(product['features']):,} sites; {len(compressed):,} gzip bytes")
    return manifest
