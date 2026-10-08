"""Build the Prince George schedule + street-network snapshot for PGMaps.

Uses only the Python standard library. Inputs are official GTFS and the existing
City of PG road/walkway snapshots. Output is deterministic for identical inputs.
"""
import argparse
import bisect
import csv
import datetime as dt
import gzip
import hashlib
import heapq
import io
import json
import math
from pathlib import Path
import zipfile
from collections import defaultdict

ROOT = Path(__file__).resolve().parent
URL = 'https://bct.tmix.se/Tmix.Cap.TdExport.WebApi/gtfs/?operatorIds=22'
LAT0 = 53.92
MX = 111320 * math.cos(math.radians(LAT0))
MY = 111320
BBOX = [-122.94, 53.78, -122.59, 54.045]


def xy(p):
    return ((p[0] + 122.8) * MX, (p[1] - LAT0) * MY)


def distance(a, b):
    x, y = xy(a); u, v = xy(b)
    return math.hypot(x - u, y - v)


def simplify(points, tolerance=8):
    if len(points) < 3:
        return points
    a, b = xy(points[0]), xy(points[-1])
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = dx * dx + dy * dy
    best, index = 0, 0
    for i, p in enumerate(points[1:-1], 1):
        x, y = xy(p)
        t = max(0, min(1, ((x-a[0])*dx + (y-a[1])*dy)/length)) if length else 0
        d = math.hypot(x-a[0]-t*dx, y-a[1]-t*dy)
        if d > best:
            best, index = d, i
    if best <= tolerance:
        return [points[0], points[-1]]
    return simplify(points[:index+1], tolerance)[:-1] + simplify(points[index:], tolerance)


def seconds(value):
    h, m, s = map(int, value.split(':'))
    return h * 3600 + m * 60 + s


def connect_endpoint_segments(nodes, adj, endpoints, add_node, link, radius=12):
    """Node endpoint junctions against street segments, not just sampled vertices.

    Only source endpoints can create junctions: two line interiors crossing
    (for example an overpass) do not become connected. Keep the existing 12 m
    street-access tolerance, and split matched edges at their projected point.
    """
    segments, segment_bins = [], defaultdict(set)
    for a, neighbors in enumerate(adj):
        for b in neighbors:
            if a >= b: continue
            start, end = xy(nodes[a]), xy(nodes[b])
            index = len(segments)
            segments.append((a, b, start, end))
            for gx in range(math.floor(min(start[0], end[0])/100), math.floor(max(start[0], end[0])/100)+1):
                for gy in range(math.floor(min(start[1], end[1])/100), math.floor(max(start[1], end[1])/100)+1):
                    segment_bins[gx, gy].add(index)
    splits, connectors = defaultdict(list), []
    for endpoint in sorted(endpoints):
        x, y = xy(nodes[endpoint])
        candidates = set()
        for gx in range(math.floor((x-radius)/100), math.floor((x+radius)/100)+1):
            for gy in range(math.floor((y-radius)/100), math.floor((y+radius)/100)+1):
                candidates.update(segment_bins[gx, gy])
        for index in sorted(candidates):
            a, b, start, end = segments[index]
            if endpoint in (a, b): continue
            dx, dy = end[0]-start[0], end[1]-start[1]
            length = dx*dx + dy*dy
            if not length: continue
            t = max(0, min(1, ((x-start[0])*dx+(y-start[1])*dy)/length))
            if math.hypot(x-start[0]-t*dx, y-start[1]-t*dy) > radius: continue
            if t == 0: junction = a
            elif t == 1: junction = b
            else:
                junction = add_node([nodes[a][0]+t*(nodes[b][0]-nodes[a][0]),
                                     nodes[a][1]+t*(nodes[b][1]-nodes[a][1])])
                splits[index].append((t, junction))
            connectors.append((endpoint, junction))
    for index, points in sorted(splits.items()):
        a, b, _, _ = segments[index]
        del adj[a][b]; del adj[b][a]
        chain = [a] + [node for _, node in sorted(points)] + [b]
        for start, end in zip(chain, chain[1:]): link(start, end)
    for start, end in connectors: link(start, end)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('gtfs', type=Path)
    parser.add_argument('--date', default=dt.date.today().isoformat())
    parser.add_argument('--grid-meters', type=float, default=50, help='Heat-grid cell size in metres (default: 50)')
    parser.add_argument('--access-meters', type=float, default=350, help='Estimated marker and heat-cell access in metres (default: 350)')
    args = parser.parse_args()
    if not math.isfinite(args.grid_meters) or args.grid_meters < 25:
        parser.error('--grid-meters must be at least 25 metres')
    if not math.isfinite(args.access_meters) or not 25 <= args.access_meters <= 1000:
        parser.error('--access-meters must be between 25 and 1000 metres')
    # argparse leaves numeric defaults as ints but parses explicit flags as
    # floats. Canonicalize equivalent settings for byte-identical metadata.
    if args.grid_meters % 1 == 0: args.grid_meters = int(args.grid_meters)
    if args.access_meters % 1 == 0: args.access_meters = int(args.access_meters)
    raw = args.gtfs.read_bytes()
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        def rows(name):
            if name not in archive.namelist():
                return []
            return list(csv.DictReader(io.TextIOWrapper(archive.open(name), encoding='utf-8-sig')))
        routes, stops, trips, times, shapes, calendar, exceptions, info = [rows(n + '.txt') for n in
            ['routes', 'stops', 'trips', 'stop_times', 'shapes', 'calendar', 'calendar_dates', 'feed_info']]

    requested = dt.date.fromisoformat(args.date)
    def services(day):
        date = day.strftime('%Y%m%d')
        weekday = day.strftime('%A').lower()
        active = {r['service_id'] for r in calendar if r['start_date'] <= date <= r['end_date'] and r[weekday] == '1'}
        for r in exceptions:
            if r['date'] == date:
                if r['exception_type'] == '1': active.add(r['service_id'])
                else: active.discard(r['service_id'])
        return active

    active = services(requested)
    if not active:
        raise SystemExit(f'No service on {requested}; choose a date within the feed validity.')
    trip_rows = sorted((t for t in trips if t['service_id'] in active), key=lambda t: t['trip_id'])
    trip_ids = {t['trip_id'] for t in trip_rows}
    stop_rows = sorted((s for s in stops if BBOX[0] <= float(s['stop_lon']) <= BBOX[2]
                        and BBOX[1] <= float(s['stop_lat']) <= BBOX[3]), key=lambda s: s['stop_id'])
    stop_index = {s['stop_id']: i for i, s in enumerate(stop_rows)}
    route_rows = sorted((r for r in routes if r['route_type'] == '3'), key=lambda r: r['route_id'])
    route_index = {r['route_id']: i for i, r in enumerate(route_rows)}

    # Keep road junctions, simplify each centreline by 8 m, then sample at <=80 m
    # for local snapping. This is a street-access estimate, not sidewalk validation.
    nodes, adj, node_index, bins, endpoints = [], [], {}, defaultdict(list), set()
    road_nodes = set()
    def add_node(p):
        key = tuple(round(v) for v in xy(p))
        if key not in node_index:
            node_index[key] = len(nodes)
            bins[(key[0]//100, key[1]//100)].append(len(nodes))
            nodes.append([round(p[0], 6), round(p[1], 6)])
            adj.append({})
        return node_index[key]

    def link(a, b):
        if a != b:
            d = round(distance(nodes[a], nodes[b]), 1)
            adj[a][b] = min(adj[a].get(b, math.inf), d)
            adj[b][a] = min(adj[b].get(a, math.inf), d)

    source_hashes = {}
    for name in ['roads', 'walkways']:
        path = ROOT.parent/'citypg'/'output'/f'{name}.geojson'
        source_hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        for f in json.loads(path.read_bytes())['features']:
            g = f['geometry']
            lines = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates'] if g['type'] == 'MultiLineString' else []
            for line in lines:
                if len(line) < 2: continue
                points = simplify(line)
                last = add_node(points[0]); endpoints.add(last)
                for a, b in zip(points, points[1:]):
                    steps = max(1, math.ceil(distance(a, b)/80))
                    for i in range(1, steps+1):
                        node = add_node([a[0]+(b[0]-a[0])*i/steps, a[1]+(b[1]-a[1])*i/steps])
                        link(last, node); last = node
                endpoints.add(last)
        if name == 'roads': road_nodes.update(range(len(nodes)))

    def nearby(p, radius):
        x, y = xy(p); gx, gy = int(x//100), int(y//100)
        steps = math.ceil(radius/100)
        return [(distance(p, nodes[i]), i) for dx in range(-steps, steps+1) for dy in range(-steps, steps+1)
                for i in bins[(gx+dx, gy+dy)] if distance(p, nodes[i]) <= radius]

    connect_endpoint_segments(nodes, adj, endpoints, add_node, link)

    # Standalone walkway assets can lie inside a property without recording its
    # access to the street. They must not steal the nearest-point snap from a
    # nearby road-connected component. Do not invent links across these gaps.
    street_access_nodes = set(road_nodes)
    pending = list(sorted(road_nodes))
    while pending:
        for node in adj[pending.pop()]:
            if node not in street_access_nodes:
                street_access_nodes.add(node)
                pending.append(node)

    # Prefer the largest road-connected component for point access. Small
    # isolated road assets can strand origins just like standalone walkways.
    unseen, largest_component = set(street_access_nodes), set()
    while unseen:
        start = min(unseen)
        component, pending = {start}, [start]
        unseen.remove(start)
        while pending:
            for node in adj[pending.pop()]:
                if node in unseen:
                    unseen.remove(node)
                    component.add(node)
                    pending.append(node)
        if len(component) > len(largest_component): largest_component = component
    isolated_walk_vertices = len(nodes)-len(street_access_nodes)
    street_access_nodes = largest_component

    def snap(p, radius=180):
        found = nearby(p, radius)
        if not found: return None
        preferred = [(d, i) for d, i in found if i in street_access_nodes]
        d, i = min(preferred or found)
        return [i, round(d, 1)]

    output_stops = [{'id': s['stop_id'], 'name': s['stop_name'],
                     'point': [float(s['stop_lon']), float(s['stop_lat'])],
                     'access': snap([float(s['stop_lon']), float(s['stop_lat'])])} for s in stop_rows]

    # Walking transfers follow the street graph, so nearby stops on opposite
    # riverbanks cannot silently connect across water.
    stops_at = defaultdict(list)
    for i, s in enumerate(output_stops):
        if s['access']: stops_at[s['access'][0]].append(i)
    transfers = [[] for _ in output_stops]
    for i, s in enumerate(output_stops):
        if not s['access']: continue
        node, offset = s['access']; dist = {node: offset}; heap = [(offset, node)]
        while heap:
            d, n = heapq.heappop(heap)
            if d != dist[n]: continue
            for j in stops_at[n]:
                total = d + output_stops[j]['access'][1]
                if j != i and total <= 650: transfers[i].append([j, round(total, 1)])
            for target, weight in adj[n].items():
                nd = d+weight
                if nd <= 650 and nd < dist.get(target, math.inf):
                    dist[target] = nd; heapq.heappush(heap, (nd, target))
        transfers[i].sort()

    shape_rows = defaultdict(list)
    for s in shapes:
        shape_rows[s['shape_id']].append(s)
    shape_data = {}
    for key, values in shape_rows.items():
        values.sort(key=lambda s: int(s['shape_pt_sequence']))
        points = [[round(float(s['shape_pt_lon']), 6), round(float(s['shape_pt_lat']), 6)] for s in values]
        distances = [float(s.get('shape_dist_traveled') or 0) for s in values]
        shape_data[key] = (points, distances)
    times_by_trip = defaultdict(list)
    for s in times:
        if s['trip_id'] in trip_ids: times_by_trip[s['trip_id']].append(s)
    patterns, pattern_index, output_trips, connections = [], {}, [], []
    for t in trip_rows:
        if t['route_id'] not in route_index: continue
        rows = sorted(times_by_trip[t['trip_id']], key=lambda s: int(s['stop_sequence']))
        # Do not join two stops across a cropped-out intermediate stop.
        if not rows or any(s['stop_id'] not in stop_index for s in rows): continue
        key = (t['route_id'], t.get('shape_id'), t['trip_headsign'], tuple(s['stop_id'] for s in rows))
        if key not in pattern_index:
            points, distances = shape_data.get(t.get('shape_id'), ([], []))
            indices = [min(len(points)-1, bisect.bisect_left(distances, float(s.get('shape_dist_traveled') or 0))) for s in rows]
            pattern_index[key] = len(patterns)
            patterns.append({'route': route_index[t['route_id']], 'headsign': t['trip_headsign'],
                             'points': points, 'stops': [stop_index[s['stop_id']] for s in rows], 'shapeIndices': indices})
        trip = len(output_trips); output_trips.append({'id': t['trip_id'], 'pattern': pattern_index[key]})
        for seq, (a, b) in enumerate(zip(rows, rows[1:])):
            departure, arrival = seconds(a['departure_time']), seconds(b['arrival_time'])
            if arrival < departure: raise ValueError(f'Non-monotone times: {t["trip_id"]}')
            connections.append([stop_index[a['stop_id']], stop_index[b['stop_id']], departure, arrival, trip, seq,
                                int(a.get('pickup_type') or 0) == 0, int(b.get('drop_off_type') or 0) == 0])
    connections.sort(key=lambda c: (c[2], c[4], c[5]))
    # Sample the same network at a finer spacing; routing and access limits stay
    # identical. Record the spacing so display resolution is not mistaken for
    # more accurate street inputs.
    cols = math.ceil((BBOX[2]-BBOX[0])*MX/args.grid_meters); rows = math.ceil((BBOX[3]-BBOX[1])*MY/args.grid_meters)
    cells = []
    for row in range(rows):
        for col in range(cols):
            p = [BBOX[0]+(col+.5)*(BBOX[2]-BBOX[0])/cols, BBOX[3]-(row+.5)*(BBOX[3]-BBOX[1])/rows]
            cells.append(snap(p, args.access_meters))

    result = {'schema': 'pg-travel-time-v1', 'meta': {'referenceDate': requested.isoformat(),
              'feedStart': dt.datetime.strptime(info[0]['feed_start_date'], '%Y%m%d').date().isoformat(),
              'feedEnd': dt.datetime.strptime(info[0]['feed_end_date'], '%Y%m%d').date().isoformat(),
              'excludedTripsOutsideStudyArea': len(trip_rows) - len(output_trips),
              'sourceUrl': URL, 'gtfsSha256': hashlib.sha256(raw).hexdigest(), 'streetSha256': source_hashes,
              'walkMetersPerSecond': 1.25, 'transferLimitMeters': 650, 'streetSimplifyMeters': 8,
              'streetJunctionMeters': 12, 'streetJunctionMethod': 'endpoint-to-segment',
              'streetAccessPreference': 'largest-road-connected-component',
              'isolatedWalkVertices': isolated_walk_vertices,
              'secondaryNetworkVertices': len(nodes)-len(street_access_nodes),
              'streetSnapMeters': 180, 'markerAccessMeters': args.access_meters,
              'gridAccessMeters': args.access_meters, 'gridCellMeters': args.grid_meters, 'bbox': BBOX},
              'routes': [{'id': r['route_id'], 'number': r['route_short_name'], 'name': r['route_long_name'],
                          'color': '#'+(r.get('route_color') or '004B8D')} for r in route_rows],
              'stops': output_stops, 'patterns': patterns, 'trips': output_trips, 'connections': connections,
              'walkNodes': nodes, 'walkEdges': [sorted(a.items()) for a in adj],
              'streetAccessNodes': sorted(street_access_nodes), 'transfers': transfers,
              'grid': {'cols': cols, 'rows': rows, 'cells': cells}}
    out = ROOT/'output'/'prince_george_travel_time.json.gz'
    out.parent.mkdir(exist_ok=True)
    payload = json.dumps(result, separators=(',', ':'), allow_nan=False).encode()
    out.write_bytes(gzip.compress(payload, mtime=0))
    print(f'{out.name}: {len(output_trips)} trips, {len(connections)} connections, {len(nodes)} street nodes, {len(payload):,} → {out.stat().st_size:,} bytes')


if __name__ == '__main__':
    main()
