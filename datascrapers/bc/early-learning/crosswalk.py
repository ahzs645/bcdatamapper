#!/usr/bin/env python3
"""Compare the dashboard's EDI polygons with current official boundaries of the same family.

Run through uv with requirements-crosswalk.txt; normalize.py itself stays
standard-library only and embeds this output when it is present and current.

The result says, per area code, whether today's official polygon covers the same
area the publisher drew for its EDI results. It is a display decision, not an
allocation: a changed or new area never receives a value from another polygon.
"""
import argparse
import json
import re
import numpy as np
import shapely
from shapely.geometry import shape
from shapely.ops import unary_union
from normalize import ROOT, boundary_geometry, current_official_boundaries, dashboard_library, digest, encoded, save

SAME_AREA_IOU = 0.95
LISTED_OVERLAP = 0.01


def equal_area(geometry):
    # Lambert cylindrical equal-area. Only area ratios are used, so the constant
    # scale factor does not matter; latitude distortion across BC does.
    return shapely.transform(geometry, lambda c: np.column_stack([np.radians(c[:, 0]), np.sin(np.radians(c[:, 1]))]))


def polygons(collection):
    return {f['properties']['regionId']: equal_area(shapely.make_valid(shape(f['geometry']))) for f in collection['features']}


def overlaps(geometry, others, tree, ids):
    found = []
    for index in tree.query(geometry, predicate='intersects'):
        other = others[ids[index]]; shared = geometry.intersection(other).area
        mine = shared / geometry.area if geometry.area else 0; theirs = shared / other.area if other.area else 0
        if max(mine, theirs) >= LISTED_OVERLAP:
            found.append({'id': ids[index], 'shareOfThis': round(mine, 4), 'shareOfOther': round(theirs, 4)})
    return sorted(found, key=lambda o: (-o['shareOfThis'], o['id']))


def compare(publisher, reference):
    """Classify publisher areas against a reference edition by area code and overlap.

    Both editions are clipped to the land they both cover first: the dashboard
    draws some areas out over water that the official layer omits, and the
    official school-district layer extends over water the dashboard omits.
    Coastline drawing is not a boundary change.
    """
    footprint = unary_union(list(publisher.values())).intersection(unary_union(list(reference.values())))
    P = {k: g.intersection(footprint) for k, g in publisher.items()}
    R = {k: g.intersection(footprint) for k, g in reference.items()}
    r_ids = sorted(R); r_tree = shapely.STRtree([R[k] for k in r_ids])
    p_ids = sorted(P); p_tree = shapely.STRtree([P[k] for k in p_ids])
    regions = {}
    for rid in p_ids:
        if rid not in R:
            regions[rid] = {'status': 'not_in_reference', 'overlaps': overlaps(P[rid], R, r_tree, r_ids)}
            continue
        union = P[rid].union(R[rid]).area
        iou = round(P[rid].intersection(R[rid]).area / union, 4) if union else 0
        regions[rid] = {'status': 'same_area', 'iou': iou} if iou >= SAME_AREA_IOU else \
            {'status': 'changed', 'iou': iou, 'overlaps': overlaps(P[rid], R, r_tree, r_ids)}
    reference_only = {rid: {'overlaps': overlaps(R[rid], P, p_tree, p_ids)} for rid in r_ids if rid not in P}
    counts = {s: sum(1 for r in regions.values() if r['status'] == s) for s in ('same_area', 'changed', 'not_in_reference')}
    return {'regions': regions, 'referenceOnly': reference_only, 'counts': {**counts, 'reference_only': len(reference_only)}}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--capture', required=True); args = parser.parse_args()
    if not re.fullmatch('[a-zA-Z0-9_-]+', args.capture): raise ValueError('Invalid capture')
    capture = ROOT / 'cache/captures' / args.capture
    library = dashboard_library(capture)
    families = {}
    for code, metadata, current in current_official_boundaries(args.capture):
        if code not in library: continue
        publisher = boundary_geometry(library[code]['collection'])
        families[code] = {'reference': f'current-{args.capture}-{code}', 'referenceEdition': metadata.get('effectiveEdition'),
                          'publisherSha256': digest(encoded(publisher)), 'referenceSha256': digest(encoded(boundary_geometry(current))),
                          **compare(polygons(publisher), polygons(current))}
        print(code, families[code]['counts'])
    save(capture / 'crosswalk.json', {
        'families': families,
        'thresholds': {'sameAreaIoU': SAME_AREA_IOU, 'listedOverlapShare': LISTED_OVERLAP},
        'method': 'Area codes are matched, then each pair is compared by intersection over union after clipping both editions to the land they both cover, in an equal-area projection. same_area permits showing that code\'s EDI value on the current polygon. changed, not_in_reference, and reference-only areas list overlapping codes for context only; values are never allocated between polygons.',
        'tool': {'shapely': shapely.__version__, 'geos': shapely.geos_version_string},
    })


if __name__ == '__main__': main()
