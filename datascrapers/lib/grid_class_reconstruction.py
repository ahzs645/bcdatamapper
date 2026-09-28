"""Recover one inferred class per assumed geographic grid cell from display labels.

Grid geometry is an explicit caller assumption, not recovered scientific metadata.
"""
import math
import numpy as np
from rasterio.transform import from_origin
from rasterio.warp import transform, transform_bounds


def reconstruct_grid(labels, source_transform, source_crs, *, west, north, step, interior=0.6,
                     min_samples=4, min_agreement=0.8, uncertain=99):
    if not 0 < interior <= 1 or not 0.5 < min_agreement <= 1 or step <= 0 or min_samples < 1:
        raise ValueError('Invalid grid or voting parameters')
    h, w = labels.shape
    t = source_transform
    if t.a <= 0 or t.e >= 0 or t.b or t.d:
        raise ValueError('Expected north-up source pixels')
    bounds = transform_bounds(source_crs, 'EPSG:4326', t.c, t.f+h*t.e, t.c+w*t.a, t.f)
    # Publish full cells only, so the assumption never extrapolates beyond the captured tiles.
    c0 = math.ceil((bounds[0]-west)/step - 1e-8)
    c1 = math.floor((bounds[2]-west)/step + 1e-8)
    r0 = math.ceil((north-bounds[3])/step - 1e-8)
    r1 = math.floor((north-bounds[1])/step + 1e-8)
    if c1 <= c0 or r1 <= r0:
        raise ValueError('Mosaic does not contain a full grid cell')
    result = np.full((r1-r0, c1-c0), uncertain, dtype='uint16')
    grid_transform = from_origin(west+c0*step, north-r0*step, step, step)
    inset = (1-interior)/2
    sample_counts, agreements = [], []
    for row in range(result.shape[0]):
        for col in range(result.shape[1]):
            left = grid_transform.c+col*step
            top = grid_transform.f-row*step
            xs, ys = transform('EPSG:4326', source_crs,
                               [left+inset*step, left+(1-inset)*step],
                               [top-inset*step, top-(1-inset)*step])
            # Include pixel centres inside the inner window; use global grid coordinates at seams.
            x0, x1 = math.ceil((xs[0]-t.c)/t.a-0.5), math.floor((xs[1]-t.c)/t.a-0.5)+1
            y0, y1 = math.ceil((ys[0]-t.f)/t.e-0.5), math.floor((ys[1]-t.f)/t.e-0.5)+1
            window = labels[max(0,y0):min(h,y1), max(0,x0):min(w,x1)]
            if window.size and np.all(window == 0):
                result[row,col] = 0
                continue
            valid = window[(window != 0) & (window != uncertain)]
            # Require adequate classified coverage as well as a majority among valid samples.
            if len(valid) < min_samples or len(valid) < window.size*min_agreement:
                continue
            values, counts = np.unique(valid, return_counts=True)
            winner = int(counts.argmax())
            share = int(counts[winner])/len(valid)
            sample_counts.append(len(valid))
            agreements.append(share)
            if share >= min_agreement:
                result[row,col] = values[winner]
    return result, grid_transform, {
        'assumedCrs': 'EPSG:4326', 'assumedOrigin': [west,north], 'assumedStepDegrees': step,
        'interiorFraction': interior, 'minimumClassifiedPixels': min_samples,
        'minimumClassifiedCoverageAndWinningShare': min_agreement,
        'minimumObservedWinningShare': min(agreements) if agreements else None,
        'minimumObservedClassifiedPixels': min(sample_counts) if sample_counts else None,
        'cellCount': int(result.size), 'uncertainCells': int((result == uncertain).sum()),
        'nodataCells': int((result == 0).sum()), 'extentPolicy': 'Full captured cells only',
    }
