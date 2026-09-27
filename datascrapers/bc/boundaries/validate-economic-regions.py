"""Validate economic-region geometry and official membership; shapely + pyproj."""
import gzip
import hashlib
import json
from collections import defaultdict
from itertools import combinations
from pathlib import Path

from pyproj import Transformer
from shapely import make_valid
from shapely.geometry import shape
from shapely.ops import transform

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "output/StatCan"
raw = json.loads(gzip.decompress((ROOT / "source/StatCanEconomicRegions/bc_economic_regions_2021.full.geojson.gz").read_bytes()))
compressed = (OUT / "bc_economic_regions_2021.geojson.gz").read_bytes()
output = json.loads(gzip.decompress(compressed))
hierarchy = json.loads((OUT / "bc_economic_regions_2021.hierarchy.json").read_text())
manifest = json.loads((OUT / "bc_economic_regions_2021.manifest.json").read_text())
expected = {f"59{i}0" for i in range(1, 9)}
assert len(output["features"]) == len(raw["features"]) == 8
assert {f["properties"]["ERUID"] for f in output["features"]} == expected
assert {f["properties"]["ERUID"] for f in raw["features"]} == expected
polys = [shape(f["geometry"]) for f in output["features"]]
assert all(g.is_valid and not g.is_empty for g in polys)
edges = defaultdict(set)
for i, feature in enumerate(output["features"]):
    geom = feature["geometry"]
    for polygon in geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]:
        for ring in polygon:
            for a, b in zip(ring, ring[1:]):
                edges[tuple(sorted((tuple(a), tuple(b))))].add(i)
shared = {tuple(sorted(owners)) for owners in edges.values() if len(owners) == 2}
adjacent = 0
for i, j in combinations(range(8), 2):
    assert polys[i].intersection(polys[j]).area == 0, f"Overlapping regions {i}, {j}"
    if polys[i].boundary.intersection(polys[j].boundary).length > 0:
        adjacent += 1
        assert (i, j) in shared, f"Adjacent regions {i}, {j} do not reuse exact edges"
project = Transformer.from_crs(4326, 3005, always_xy=True).transform
original = {f["properties"]["ERUID"]: transform(project, make_valid(shape(f["geometry"]))) for f in raw["features"]}
changes = {f["properties"]["ERUID"]: abs(transform(project, g).area / original[f["properties"]["ERUID"]].area - 1) * 100
           for f, g in zip(output["features"], polys)}
assert max(changes.values()) < 0.1, changes
divisions = {d["code"]: d for d in hierarchy["censusDivisions"]}
subdivisions = {s["code"]: s for s in hierarchy["censusSubdivisions"]}
assert len(divisions) == len(hierarchy["censusDivisions"]) == 29
assert len(subdivisions) == len(hierarchy["censusSubdivisions"]) == 751
assert {r["code"] for r in hierarchy["economicRegions"]} == expected
for division in divisions.values():
    assert division["economicRegionCode"] in expected
for subdivision in subdivisions.values():
    parent = divisions[subdivision["censusDivisionCode"]]
    assert subdivision["economicRegionCode"] == parent["economicRegionCode"]
    assert subdivision["code"].startswith(parent["code"])
assert subdivisions["5953023"]["economicRegionCode"] == "5950"  # Prince George → Cariboo
assert divisions["5945"]["economicRegionCode"] == "5910"  # Central Coast is not North Coast ER
assert divisions["5957"]["economicRegionCode"] == "5970"  # Stikine is a statistical equivalent
for f in output["features"]:
    assert f["properties"]["censusDivisionCodes"] == sorted(d["code"] for d in divisions.values() if d["economicRegionCode"] == f["properties"]["ERUID"])
assert manifest["sha256"] == hashlib.sha256(compressed).hexdigest()
report = {"features": 8, "validGeometries": 8, "pairsChecked": 28, "polygonAreaOverlaps": 0,
          "adjacentFeaturePairs": adjacent, "exactSharedSegments": sum(len(v) == 2 for v in edges.values()),
          "maxAreaChangePercent": max(changes.values()), "areaChangesPercent": changes, "areaComparisonCrs": "EPSG:3005",
          "censusDivisions": 29, "censusSubdivisions": 751, "officialMembershipValidated": True,
          "rawGeojsonBytes": manifest["rawGeojsonBytes"], "optimizedGeojsonBytes": len(gzip.decompress(compressed)),
          "gzipBytes": len(compressed)}
(OUT / "bc_economic_regions_2021.validation.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
