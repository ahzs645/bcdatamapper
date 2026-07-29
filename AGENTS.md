# BC Data Mapper Agent Instructions

## Boundary geometry optimization

- Use topology-preserving simplification for polygon layers whose features share boundaries, such as administrative zones, watersheds, municipalities, health regions, and electoral areas.
- Process the complete set of adjacent polygons together as one layer. Do not simplify neighboring polygons independently with `@turf/simplify`; independent simplification can create gaps and overlaps.
- Prefer the Mapshaper workflow already used by the BCER administrative-zone and Freshwater Atlas boundary builders. Pin the Mapshaper version rather than relying on an unversioned `npx mapshaper` invocation.
- Simplify in an appropriate projected coordinate reference system so tolerances are expressed in meaningful linear units. For province-wide British Columbia data, prefer BC Albers (EPSG:3005) and express the tolerance in metres. Reproject browser GeoJSON to WGS84 (EPSG:4326) after simplification.
- Use shared-topology cleaning and shape preservation. A typical polygon pipeline is:

  ```text
  -clean -simplify dp interval=<metres> keep-shapes -clean
  ```

- Choose the tolerance according to the map's display scale and document it. Do not silently reuse a tolerance selected for another dataset.
- Preserve stable identifiers and only the attributes required by the application. Round output coordinates consistently and write deterministic snapshots when the dataset is deployed with the app.
- Record the source service/layer, source and output CRS, simplification algorithm, tolerance, topology-preserving status, and Mapshaper version in output metadata.

## Boundary validation

Before accepting an optimized shared-boundary layer:

1. Confirm the expected feature count and identifiers.
2. Confirm neighboring polygons reuse exact shared edges in the output.
3. Check every feature pair for polygon-area overlaps; the expected count is zero unless the source intentionally overlaps.
4. Compare source and optimized feature areas and report the maximum percentage change.
5. Inspect important multi-zone junctions visually at a close zoom.
6. Measure raw, optimized, and gzip-compressed payload sizes.
7. Run the scraper twice when practical and confirm the deployable output is deterministic.

If the source polygons intentionally overlap, are isolated features, or are not a partition, document that fact and select validation appropriate to the dataset instead of forcing partition-style checks.

## Reference implementations

- `datascrapers/bc/boundaries/sync-bcer-admin-zones.mjs`
- `datascrapers/bc/boundaries/build-dev-bc-fwa-watersheds.mjs`
