"""Extract exact numeric polygon blocks and QGIS ramps from the NH consultant archive."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile

import numpy as np
import rasterio
from rasterio.features import rasterize

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'lib'))
from categorical_raster import convert, encode_json

ARCHIVE_SHA256 = 'bc8277c5cb579e661c247d9e804c2e0d35cdace1311c761d283b848a650fe5bc'
LAYERS = [
    ('hot-days-past', 'NH_ssp585_txgt_29_p50_1971-2000_wgs84', 'Days >29°C, 1971–2000', 'days/year'),
    ('hot-days-future', 'NH_ssp585_txgt_29_p50_2071-2100_wgs84', 'Days >29°C, 2071–2100', 'days/year'),
    ('summer-precip-change', 'NH_ssp585_prcptot_summer_future-past_wgs84', 'Summer precipitation change', 'mm'),
    ('precip-change', 'NH_ssp585_prcptot_winter_future-past_wgs84', 'Winter precipitation change', 'mm'),
]


def build(source, output):
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != ARCHIVE_SHA256:
        raise ValueError('Source does not match the verified consultant archive')
    with sqlite3.connect(f'file:{source.resolve()}?mode=ro', uri=True) as db:
        packed = db.execute("SELECT content FROM qgis_projects WHERE name='MAP'").fetchone()[0]
    with zipfile.ZipFile(io.BytesIO(bytes.fromhex(packed))) as project_zip:
        qgs = project_zip.read(next(n for n in project_zip.namelist() if n.endswith('.qgs')))
    project = ET.fromstring(qgs)
    output.mkdir(parents=True, exist_ok=True)
    summary = {'format': 'echoscreen-climate-vectors-v1', 'source': {
        'name': source.name, 'sha256': digest, 'bytes': source.stat().st_size,
        'url': 'https://drive.google.com/file/d/1Qz7bXQbK6pjzBPF1D0uhlqQgf36LpS_l/view',
        'projectSha256': hashlib.sha256(qgs).hexdigest(),
    }, 'layers': []}
    for layer_id, table, label, units in LAYERS:
        qgis_layer = next(l for l in project.findall('./projectlayers/maplayer') if l.findtext('layername') == table)
        renderer = qgis_layer.find('pipe/rasterrenderer')
        shader = renderer.find('rastershader/colorrampshader')
        if renderer.get('type') != 'singlebandpseudocolor' or shader.get('colorRampType') != 'INTERPOLATED':
            raise ValueError('Expected the original continuous single-band QGIS style')
        stops = []
        for item in shader.findall('item'):
            color = item.get('color').lstrip('#')
            stops.append({'value': float(item.get('value')), 'label': item.get('label'),
                          'color': [int(color[i:i+2], 16) for i in (0, 2, 4)] + [int(item.get('alpha', '255'))]})
        style = {'interpolation': 'linear', 'clip': shader.get('clip') == '1',
                 'opacity': float(renderer.get('opacity', '1')), 'stops': stops}
        with rasterio.open(f'GPKG:{source}:{table}') as src, tempfile.TemporaryDirectory() as work:
            work = Path(work)
            masked = src.read(1, masked=True)
            data, mask = masked.data, ~np.ma.getmaskarray(masked)
            if src.crs.to_epsg() != 4326 or data.dtype != np.dtype('float32'):
                raise ValueError('Expected the original WGS84 Float32 grid')
            unique = np.unique(data[mask])
            codes = np.zeros(data.shape, dtype='uint16')
            codes[mask] = np.searchsorted(unique, data[mask]) + 1
            ids = work / 'ids.tif'
            with rasterio.open(ids, 'w', driver='GTiff', width=src.width, height=src.height,
                               count=1, dtype='uint16', nodata=0, crs=src.crs, transform=src.transform) as target:
                target.write(codes, 1)
            encoded = convert(ids, work / 'polygons', block_size=128, max_classes=65535)
            destination = output / layer_id
            (destination / 'tiles').mkdir(parents=True, exist_ok=True)
            all_shapes, tiles = [], []
            for tile in encoded['tiles']:
                collection = json.loads(gzip.decompress((work / 'polygons' / tile['path']).read_bytes()))
                for feature in collection['features']:
                    feature['properties']['value'] = float(unique[feature['properties']['value'] - 1])
                    all_shapes.append((feature['geometry'], feature['properties']['value']))
                body = gzip.compress(encode_json(collection), compresslevel=9, mtime=0)
                (destination / tile['path']).write_bytes(body)
                tiles.append(tile | {'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
            restored = rasterize(all_shapes, out_shape=data.shape, transform=src.transform, fill=np.nan, dtype='float32')
            if not np.array_equal(restored[mask], data[mask]) or not np.isnan(restored[~mask]).all():
                raise ValueError('Published numeric values or missing-data coverage changed')
            manifest = {'format': 'numeric-raster-polygons-v1', 'label': label, 'units': units,
                        'scenario': 'SSP585', 'percentile': 'P50' if 'hot-days' in layer_id else '',
                        'period': '1971–2000' if layer_id == 'hot-days-past' else '2071–2100',
                        'baseline': '1971–2000', 'thresholdC': 29 if 'hot-days' in layer_id else None,
                        'source': summary['source'] | {'table': table, 'width': src.width, 'height': src.height,
                                                     'crs': 'EPSG:4326', 'transform': list(src.transform)[:6]},
                        'attribution': 'Northern Health consultant archive; ClimateData.ca, BCCAQv2, CMIP6',
                        'style': style, 'blockSize': 128, 'simplification': None,
                        'validCells': int(mask.sum()), 'features': encoded['features'],
                        'minValue': float(data[mask].min()), 'maxValue': float(data[mask].max()),
                        'validation': encoded['validation'] | {'exactFloat32Values': True, 'missingDataPreserved': True},
                        'gzipBytes': sum(t['bytes'] for t in tiles), 'tiles': tiles}
            (destination / 'manifest.json').write_bytes(encode_json(manifest))
            summary['layers'].append({'id': layer_id, 'manifest': f'{layer_id}/manifest.json',
                                      'bytes': manifest['gzipBytes'] + (destination / 'manifest.json').stat().st_size,
                                      'validCells': manifest['validCells'], 'features': manifest['features']})
    summary['layerBytes'] = sum(l['bytes'] for l in summary['layers'])
    (output / 'manifest.json').write_bytes(encode_json(summary))
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, default=Path(__file__).parent / 'output')
    args = parser.parse_args()
    build(args.source, args.output)
