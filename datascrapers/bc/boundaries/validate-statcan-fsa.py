"""Validate FSA display geometry. Requires shapely and pyproj."""
import gzip,json
from collections import defaultdict
from pathlib import Path
from shapely.geometry import shape
from shapely.ops import transform, unary_union
from shapely import make_valid
from pyproj import Transformer
root=Path(__file__).resolve().parent
raw=json.loads((root/'source/StatCanFSA/bc_fsa_2021_full.geojson').read_text())
output=json.loads(gzip.decompress((root/'output/StatCan/bc_fsa_2021.geojson.gz').read_bytes()))
assert len(output['features'])==len(raw['features'])==191
assert {f['properties']['CFSAUID'] for f in raw['features']}=={f['properties']['CFSAUID'] for f in output['features']}
project=Transformer.from_crs(4326,3005,always_xy=True).transform
src={f['properties']['CFSAUID']:make_valid(shape(f['geometry'])) for f in raw['features']}
polys=[shape(f['geometry']) for f in output['features']]
assert all(g.is_valid and not g.is_empty for g in polys), 'Invalid output geometry'
projected=[transform(project,g) for g in polys]
changes=[]
for f,g in zip(output['features'],projected):
 code=f['properties']['CFSAUID'];original=transform(project,src[code]);changes.append((abs(g.area/original.area-1)*100,code))
overlaps=[];adjacent=0
edges=defaultdict(set)
for i,f in enumerate(output['features']):
 geom=f['geometry'];parts=geom['coordinates'] if geom['type']=='MultiPolygon' else [geom['coordinates']]
 for part in parts:
  for ring in part:
   for a,b in zip(ring,ring[1:]):edges[tuple(sorted((tuple(a),tuple(b))))].add(i)
sharedPairs=set()
sharedSegments=0
for owners in edges.values():
 if len(owners)==2:sharedPairs.add(tuple(sorted(owners)));sharedSegments+=1
for i in range(len(polys)):
 for j in range(i+1,len(polys)):
  # Test intersection in the delivered CRS; transforming straight segment endpoints
  # independently can introduce artificial slivers at collinear junctions.
  intersection=polys[i].intersection(polys[j])
  if intersection.area>0:overlaps.append([i,j,intersection.area])
  if polys[i].boundary.intersection(polys[j].boundary).length>0:
   adjacent+=1;assert (i,j) in sharedPairs, (i,j,'no exact shared edge')
assert not overlaps, overlaps[:5]
parent=json.loads(gzip.decompress((root/'output/StatCan/bc_postal_region_2021.geojson.gz').read_bytes()))
assert len(parent['features']) == 1
parent_shape=shape(parent['features'][0]['geometry'])
assert parent_shape.is_valid and parent_shape.equals(unary_union(polys)), 'Postal parent differs from union of child FSAs'
report={'postalParentValid': True, 'postalParentExactlyMatchesChildUnion': True, 'features':191,'validGeometries':191,'pairsChecked':191*190//2,'polygonAreaOverlaps':len(overlaps),'adjacentFeaturePairs':adjacent,'exactSharedSegments':sharedSegments,'maxAreaChangePercent':max(changes)[0],'maxAreaChangeFsa':max(changes)[1],'areaComparisonCrs':'EPSG:3005','topAreaChanges':sorted(changes,reverse=True)[:10]}
(root/'output/StatCan/bc_fsa_2021.validation.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
