# Polygon topology pipeline

All generated, simplified polygon datasets must use
`simplifyPolygonTopology()` from `mapshaper-topology.mjs`. The utility pins the
Mapshaper version, simplifies in a projected CRS with metre-based tolerances,
keeps shared borders on identical arcs, validates feature counts and geometry,
and writes a common metadata contract.

Empty polygon shells are excluded and counted in
`droppedInvalidGeometryFeatureCount`; other geometry types are rejected. In
overlap mode, valid tiny polygons that Mapshaper cannot simplify safely are
retained unsimplified and counted in `unsimplifiedFallbackFeatureCount`.

Always pass the complete set of neighbouring or overlapping features to the
utility before splitting it into files, tiles, or chunks. Simplifying chunks or
features separately can create visible gaps at their boundaries.

## Profiles

- `TOPOLOGY_PROFILES.PARTITION` is for non-overlapping boundary mosaics such as
  census subdivisions, health areas, municipalities, and administrative zones.
  It cleans topology before and after simplification and reprojection.
- `TOPOLOGY_PROFILES.OVERLAP` is for thematic polygons whose overlaps are
  meaningful, such as tenures, Indigenous interests, drought regions, and
  ungulate winter ranges. It shares the same Mapshaper implementation but does
  not clean or auto-repair intersections, so intentional overlaps and small
  source features remain intact.

Every caller must select a profile explicitly.

```js
import {
  simplifyPolygonTopology,
  TOPOLOGY_PROFILES,
} from './mapshaper-topology.mjs'

const simplified = simplifyPolygonTopology(collection, {
  toleranceMetres: 50,
  sourceCrs: 'EPSG:4326',
  workingCrs: 'EPSG:3005',
  outputCrs: 'EPSG:4326',
  coordinatePrecision: 6,
  topologyProfile: TOPOLOGY_PROFILES.PARTITION,
})
```

Non-JavaScript builders use the file CLI, which calls the same function:

```sh
npm run boundaries:simplify-file -- \
  --input input.geojson \
  --output output.geojson \
  --tolerance-metres 50 \
  --source-crs EPSG:4326 \
  --working-crs EPSG:3005 \
  --output-crs EPSG:4326 \
  --coordinate-precision 6 \
  --topology-profile partition
```

The output metadata includes the CRS chain, tolerance, profile, cleaning and
overlap semantics, coordinate precision, and pinned Mapshaper version. Preserve
that metadata when adding dataset-specific provenance.
