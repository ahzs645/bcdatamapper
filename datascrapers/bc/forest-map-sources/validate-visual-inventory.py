"""uv run --with shapely==2.1.2 --with pyproj==3.7.2 python <this file>

Check every bbox-intersecting polygon pair, including source overlaps. VSU
inventory is thematic and can overlap; simplification must not erase units.
"""
import gzip
import json
from collections import Counter
from pathlib import Path
import shapely
from shapely.geometry import shape
from shapely.ops import transform
from shapely.strtree import STRtree
from pyproj import Transformer

root = Path(__file__).parent
project = Transformer.from_crs(4326, 3005, always_xy=True).transform
raw = {}
raw_invalid = 0
cache = root / 'source/visual-inventory'
pages = json.loads((cache / 'source-pages.json').read_text()) if (cache / 'source-pages.json').exists() else [p.name for p in cache.glob('*.geojson.gz')]
for page in sorted(pages):
    path = cache / page
    for feature in json.loads(gzip.decompress(path.read_bytes()))['features']:
        geometry = transform(project, shape(feature['geometry']))
        raw_invalid += not geometry.is_valid
        raw[str(feature['properties']['OBJECTID'])] = shapely.make_valid(geometry)
collection = {'features': []}
for path in sorted((root / 'output/visual-inventory').glob('units-*.geojson.gz')):
    collection['features'].extend(json.loads(gzip.decompress(path.read_bytes()))['features'])
ids = [str(f['properties']['OBJECTID']) for f in collection['features']]
assert len(set(ids)) == len(ids) == len(raw), 'Duplicate or missing identifiers'
assert set(ids) == set(raw), 'Identifiers changed'
assert all(str(f['properties'].get('VLI_POLYGON_NO', '')).strip() for f in collection['features']), 'Unparseable unit label'
optimized = [transform(project, shape(f['geometry'])) for f in collection['features']]
invalid = sum(not g.is_valid for g in optimized)
optimized = [shapely.make_valid(g) for g in optimized]
assert all(g.equals_exact(raw[i], tolerance=0) for i,g in zip(ids,optimized)), 'Source geometry changed'
changes = [abs(g.area - raw[i].area) / raw[i].area * 100 for i,g in zip(ids,optimized) if raw[i].area > 0]

def overlap_pairs(geometries):
    tree = STRtree(geometries)
    pairs = {}
    for i,g in enumerate(geometries):
        for j in tree.query(g):
            if j <= i: continue
            area = g.intersection(geometries[j]).area
            if area > 1: pairs[(int(i),int(j))] = area
    return pairs

source_pairs = overlap_pairs([raw[i] for i in ids])
output_pairs = overlap_pairs(optimized)
introduced = {pair: area for pair,area in output_pairs.items() if pair not in source_pairs}
edges = Counter()
for f in collection['features']:
    polygons = [f['geometry']['coordinates']] if f['geometry']['type'] == 'Polygon' else f['geometry']['coordinates']
    feature_edges = set()
    for polygon in polygons:
        for ring in polygon:
            for a,b in zip(ring,ring[1:]): feature_edges.add(tuple(sorted((tuple(a),tuple(b)))))
    edges.update(feature_edges)
report = dict(featureCount=len(ids), sourceInvalidGeometries=raw_invalid, outputInvalidGeometries=invalid,
              sourceOverlapPairsOver1sqm=len(source_pairs), outputOverlapPairsOver1sqm=len(output_pairs),
              introducedOverlapPairsOver1sqm=len(introduced), maxIntroducedOverlapSqm=max(introduced.values(),default=0),
              sharedExactEdges=sum(n>1 for n in edges.values()), maximumAbsoluteAreaChangePercent=max(changes),
              p99AbsoluteAreaChangePercent=sorted(changes)[int(.99*len(changes))],
              note='The source contains overlapping thematic VSU polygons. Source overlaps are preserved; this is not a province-wide land partition. All source coordinates and topology are preserved exactly. Existing source geometry defects are retained for review. Boundaries are screening candidates, not survey geometry.')
(root / 'output/visual-inventory/validation.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
