"""Bounded, reproducible CCISS WebP display-class reconstruction; never numeric CCISS data."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import warnings

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import transform_bounds

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'lib'))
from categorical_raster import convert
from palette_classes import classify_rgba
from grid_class_reconstruction import reconstruct_grid
from rasterio.warp import reproject, Resampling

PALETTE = {10: [0,100,0], 20: [30,144,255], 30: [238,201,0], 40: [247,247,247]}
LAYER = 'NewFeas_1961_1990_ref_C4_Pl'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--longitude', type=float, required=True)
    p.add_argument('--latitude', type=float, required=True)
    p.add_argument('--archive', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--grid', action='store_true', help='Use an assumed 10-arc-second cell grid and interior votes')
    args = p.parse_args()
    if args.output.exists():
        raise ValueError('Choose a new output directory')
    if not (-139 <= args.longitude <= -114 and 48 <= args.latitude <= 60):
        raise ValueError('Pilot centre must be in BC')
    zoom, count, size = 12, 3, 256
    cx = int((args.longitude + 180) / 360 * 2**zoom)
    cy = int((1 - math.asinh(math.tan(math.radians(args.latitude))) / math.pi) / 2 * 2**zoom)
    xmin, ymin = cx - 1, cy - 1
    image = np.zeros((4, size*count, size*count), dtype='uint8')
    sources = []
    args.archive.mkdir(parents=True, exist_ok=True)
    for y in range(ymin, ymin+count):
        for x in range(xmin, xmin+count):
            url = f'https://tileserver.thebeczone.ca/data/{LAYER}/{zoom}/{x}/{y}.webp'
            path = args.archive / f'{zoom}-{x}-{y}.webp'
            if not path.exists():
                subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location', '--max-time', '30', url, '-o', str(path)], check=True)
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', rasterio.errors.NotGeoreferencedWarning)
                with rasterio.open(path) as src:
                    if src.width != size or src.height != size or src.count not in (3,4):
                        raise ValueError('Unexpected source tile format')
                    data = src.read()
            rgba = np.concatenate([data, np.full((1,size,size),255,dtype='uint8')]) if len(data)==3 else data
            image[:, (y-ymin)*size:(y-ymin+1)*size, (x-xmin)*size:(x-xmin+1)*size] = rgba
            sources.append({'url': url, 'file': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    labels = classify_rgba(image, PALETTE)
    half = math.pi * 6378137
    resolution = 2*half / (2**zoom * size)
    transform = from_origin(-half + xmin*size*resolution, half - ymin*size*resolution, resolution, resolution)
    original_labels = labels
    original_transform = transform
    grid_report = None
    output_crs = 'EPSG:3857'
    if args.grid:
        metadata_path = args.archive / 'tilejson.json'
        if not metadata_path.exists():
            raise ValueError('Archive the matching layer TileJSON as tilejson.json before using the grid assumption')
        metadata = json.loads(metadata_path.read_text())
        if metadata.get('id') != LAYER:
            raise ValueError('TileJSON does not match the archived layer')
        labels, transform, grid_report = reconstruct_grid(labels, transform, 'EPSG:3857',
            west=metadata['bounds'][0], north=metadata['bounds'][3], step=1/360)
        grid_report['originEvidence'] = 'Archived TileJSON west/north bounds'
        grid_report['stepEvidence'] = 'Assumed 10 arc-seconds; fits repeated displayed edges in this pilot'
        grid_report['tilejsonSha256'] = hashlib.sha256(metadata_path.read_bytes()).hexdigest()
        output_crs = 'EPSG:4326'
        # Compare ALL eligible image pixels, including those outside the voting interiors.
        back = np.zeros(original_labels.shape, dtype='uint16')
        reproject(labels, back, src_transform=transform, src_crs=output_crs, src_nodata=0,
                  dst_transform=original_transform, dst_crs='EPSG:3857', dst_nodata=0,
                  resampling=Resampling.nearest)
        eligible = (back != 0) & (back != 99) & (original_labels != 0) & (original_labels != 99)
        grid_report['comparedClassifiedImagePixels'] = int(eligible.sum())
        grid_report['disagreeingClassifiedImagePixels'] = int(((back != original_labels) & eligible).sum())
        if not eligible.any():
            raise ValueError('No classified image pixels available to validate the grid assumption')
        grid_report['displayPixelAgreement'] = float((back[eligible] == original_labels[eligible]).mean())
        if grid_report['displayPixelAgreement'] < 0.995:
            raise ValueError('Assumed grid disagrees with more than 0.5% of classified image pixels; review spacing/alignment')
        grid_report['notSourceDataAccuracy'] = True
    args.output.mkdir(parents=True)
    raster_path = args.output / 'inferred-display-classes.tif'
    with rasterio.open(raster_path, 'w', driver='GTiff', width=labels.shape[1], height=labels.shape[0], count=1,
                       dtype='uint16', crs=output_crs, transform=transform, nodata=0, compress='deflate') as dst:
        dst.write(labels, 1)
        dst.update_tags(DESCRIPTION='INFERRED WEBP DISPLAY CLASSES. Not original CCISS numeric data.')
    manifest = convert(raster_path, args.output / 'polygons')
    bounds = transform_bounds(output_crs,'EPSG:4326', transform.c, transform.f+labels.shape[0]*transform.e,
                              transform.c+labels.shape[1]*transform.a, transform.f)
    values, counts = np.unique(labels, return_counts=True)
    report = {'kind': 'inferred-display-classes', 'authoritativeNumericData': False,
              'gridReconstruction': grid_report, 'layer': LAYER, 'zoom': zoom, 'bounds': bounds, 'palette': PALETTE,
              'classifier': {'metric': 'Euclidean sRGB', 'maxDistance': 60, 'minMargin': 20, 'minAlpha': 250,
                             'uncertainCode': 99, 'nodataCode': 0, 'meaning': 'Heuristic thresholds, not calibrated confidence'},
              'counts': dict(zip(map(str,values),map(int,counts))), 'rasterCells': int(labels.size), 'sourceImagePixels': int(original_labels.size),
              'sources': sources, 'validation': manifest['validation'], 'gzipBytes': manifest['gzipBytes'],
              'features': manifest['features'], 'scope': 'Nine zoom-12 tiles around requested location; no smoothing'}
    (args.output / 'provenance.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k != 'sources'},indent=2))


if __name__ == '__main__':
    main()
