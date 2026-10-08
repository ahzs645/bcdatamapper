"""Sweep walking access and connectivity over the complete study area.

Reports coverage rather than treating water/forest beyond the access radius as
failures. --baseline compares an earlier snapshot. Uses the standard library.
"""
import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('builder', ROOT/'build-travel-time.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
REPORTED_POINTS = [(-122.776639, 53.901750), (-122.779805, 53.902121), (-122.776657, 53.902947)]


def components(data):
    labels = [-1]*len(data['walkNodes'])
    groups = []
    for start in range(len(labels)):
        if labels[start] >= 0: continue
        label = len(groups)
        labels[start] = label
        nodes, pending = [], [start]
        while pending:
            node = pending.pop()
            nodes.append(node)
            for neighbor, _ in data['walkEdges'][node]:
                if labels[neighbor] < 0:
                    labels[neighbor] = label
                    pending.append(neighbor)
        groups.append(nodes)
    primary = max(range(len(groups)), key=lambda i: len(groups[i]))
    return labels, groups, primary


def access_index(data):
    positions = [builder.xy(point) for point in data['walkNodes']]
    bins = defaultdict(list)
    for i, (x, y) in enumerate(positions): bins[math.floor(x/100), math.floor(y/100)].append(i)
    preferred = set(data.get('streetAccessNodes', range(len(positions))))

    def access(point, radius):
        x, y = builder.xy(point)
        best, favored = (radius*radius, -1), (radius*radius, -1)
        for gx in range(math.floor((x-radius)/100), math.floor((x+radius)/100)+1):
            for gy in range(math.floor((y-radius)/100), math.floor((y+radius)/100)+1):
                for i in bins.get((gx, gy), ()):
                    u, v = positions[i]
                    d = (u-x)**2 + (v-y)**2
                    if d <= best[0]: best = (d, i)
                    if i in preferred and d <= favored[0]: favored = (d, i)
        d, i = favored if favored[1] >= 0 else best
        return None if i < 0 else (i, math.sqrt(d))

    return access


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, default=ROOT/'output/prince_george_travel_time.json.gz')
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--spacing', type=float, default=50)
    parser.add_argument('--report', type=Path, default=ROOT/'output/travel-time-audit.json')
    parser.add_argument('--strict', action='store_true')
    args = parser.parse_args()
    if not math.isfinite(args.spacing) or args.spacing < 25: parser.error('spacing must be at least 25 metres')
    data = json.loads(gzip.decompress(args.snapshot.read_bytes()))
    baseline = json.loads(gzip.decompress(args.baseline.read_bytes())) if args.baseline else data
    labels, groups, primary = components(data)
    access, before = access_index(data), access_index(baseline)
    radius = data['meta'].get('markerAccessMeters', data['meta'].get('streetSnapMeters', 180))
    heat_radius = data['meta'].get('gridAccessMeters', 150)
    old_radius = baseline['meta'].get('markerAccessMeters', baseline['meta'].get('streetSnapMeters', 180))
    old_heat_radius = baseline['meta'].get('gridAccessMeters', 150)
    west, south, east, north = data['meta']['bbox']
    cols = math.ceil((east-west)*builder.MX/args.spacing)
    rows = math.ceil((north-south)*builder.MY/args.spacing)
    counts = Counter()
    residual = []
    for row in range(rows):
        for col in range(cols):
            point = [west+(col+.5)*(east-west)/cols, north-(row+.5)*(north-south)/rows]
            marker = access(point, radius)
            heat = marker if radius == heat_radius else access(point, heat_radius)
            old_marker = before(point, old_radius)
            old_heat = old_marker if old_radius == old_heat_radius else before(point, old_heat_radius)
            counts['sampledLocations'] += 1
            counts['markerAccessBefore'] += old_marker is not None
            counts['markerAccessAfter'] += marker is not None
            counts['heatAccessBefore'] += old_heat is not None
            counts['heatAccessAfter'] += heat is not None
            counts['markerHeatMismatchBefore'] += (old_marker is None) != (old_heat is None)
            counts['markerHeatMismatchAfter'] += marker != heat
            counts['newlyAccessibleLocations'] += marker is not None and old_marker is None
            counts['isolatedAccessLocations'] += marker is not None and labels[marker[0]] != primary
            if marker and labels[marker[0]] != primary and len(residual) < 20:
                residual.append({'point': point, 'component': labels[marker[0]], 'accessMeters': round(marker[1], 1)})

    def location(point, name):
        a, b = before(point, old_radius), access(point, radius)
        return {'name': name, 'point': point, 'accessibleBefore': a is not None,
                'accessibleAfter': b is not None, 'connectedToCity': b is not None and labels[b[0]] == primary,
                'accessMeters': round(b[1], 1) if b else None}

    places = []
    for name in ['civic_facility_buildings', 'parks_facilities']:
        path = ROOT.parent/'citypg/output'/f'{name}.geojson'
        for feature in json.loads(path.read_bytes())['features']:
            g = feature.get('geometry')
            if not g: continue
            ring = g['coordinates'][0] if g['type'] == 'Polygon' else g['coordinates'][0][0]
            point = [sum(p[i] for p in ring[:-1])/(len(ring)-1) for i in range(2)]
            if west <= point[0] <= east and south <= point[1] <= north:
                props = feature['properties']
                places.append(location(point, props.get('ShortName') or props.get('Location') or str(props['OBJECTID'])))
    reported = [location(point, 'User-reported starting point') for point in REPORTED_POINTS]
    component_report = [{'vertices': len(nodes), 'stops': sum(1 for s in data['stops'] if s['access'] and labels[s['access'][0]] == i),
                         'representative': data['walkNodes'][nodes[0]], 'primary': i == primary}
                        for i, nodes in enumerate(groups)]
    failures = []
    if radius != heat_radius: failures.append('Marker and heat access radii differ')
    if counts['markerHeatMismatchAfter']: failures.append('Marker/heat access disagrees during the sweep')
    if any(not p['connectedToCity'] for p in reported): failures.append('A reported point does not reach the primary street network')
    # Full walking connectivity implies a finite walking route between any two
    # accesses in the primary component; this avoids running Dijkstra 270k times.
    preferred = data.get('streetAccessNodes', [])
    if any(labels[i] != primary for i in preferred): failures.append('Preferred access can still select an isolated component')
    report = {'schema': 'pg-travel-time-audit-v1', 'snapshotSha256': hashlib.sha256(args.snapshot.read_bytes()).hexdigest(),
              'baselineSha256': hashlib.sha256(args.baseline.read_bytes()).hexdigest() if args.baseline else None,
              'bbox': data['meta']['bbox'], 'spacingMeters': args.spacing, 'cols': cols, 'rows': rows,
              'markerAccessMeters': radius, 'heatAccessMeters': heat_radius, 'counts': dict(counts),
              'components': component_report, 'reportedPoints': reported,
              'places': {'checked': len(places), 'accessibleBefore': sum(p['accessibleBefore'] for p in places),
                         'accessibleAfter': sum(p['accessibleAfter'] for p in places),
                         'residual': [p for p in places if not p['connectedToCity']]},
              'isolatedAccessExamples': residual, 'failures': failures}
    args.report.parent.mkdir(exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps({key: report[key] for key in ['spacingMeters', 'counts', 'places', 'reportedPoints', 'failures']}, indent=2))
    if args.strict and failures: raise SystemExit(1)


if __name__ == '__main__': main()
