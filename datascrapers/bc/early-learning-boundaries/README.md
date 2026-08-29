# BC early-learning boundary sources

This scraper inventories and measures the three boundary families used by the
UBC EDI dashboard that were not already complete in PGMaps:

- Ministry of Education and Child Care school districts (`GEOSD`);
- HELP neighbourhoods (`NH`), nested in school districts; and
- Ministry of Children and Family Development Regions, Service Delivery Areas,
  and Local Service Areas (`MCFD -> SDA -> LSA`).

Run from `vendor/bcdatamapper`:

```sh
npm run early-learning-boundaries:sync
```

The command writes the redistributable school-district snapshot to
`output/BCSchoolDistricts`, writes restricted local assessment files under the
ignored `cache` directory, downloads the public Wave 2-8 aggregate EDI workbook
to that cache, and refreshes `output/audit-report.json` with source, optimized,
and gzip sizes plus geometry, hierarchy, and workbook provenance.
`output/index.json` inventories every boundary file type and records whether its
geometry is deployable output or a restricted local-cache file.

From the PGMaps root, `npm run early-learning-boundaries:sync` performs the
deployment-safe assembly. For local source inspection only,
`npm run early-learning-boundaries:sync:local` first captures the dashboard LSA
snapshot, then additionally materializes HELP Neighbourhood and MCFD
Region/SDA/LSA files under `public/data/boundaries`.
Normal data syncs remove those restricted public copies so they cannot persist
into a subsequent build.

The dashboard itself also sends a complete historical 47-polygon MCFD LSA
vector layer to its Leaflet map. Capture that runtime snapshot locally with:

```sh
npm run early-learning-boundaries:capture-dashboard-lsa
```

The command writes the captured 47-LSA layer, dissolves it into same-vintage
13-SDA and 4-Region layers, and writes `cache/dashboard_mcfd_boundary_index.json`.
Every GeoJSON layer also gets a deterministic gzip copy. A local PGMaps sync
places them under `public/data/boundaries/BCMCFD`; normal deployment-safe syncs
remove that directory because the dashboard publishes no dataset-specific open
redistribution licence.

## Redistribution policy

The school-district layer is published under the Open Government Licence -
British Columbia, so its normalized browser snapshot and deterministic gzip
copy are committed.

The UBC Data Library publishes the HELP shapefiles for direct download but does
not attach a dataset-specific open licence. UBC's general Terms of Use prohibit
republication or redissemination without prior written consent. The audit may
download and analyze the files locally, but the archive and derived geometry
remain ignored until permission is documented.

The same policy is applied to the Data Library's Wave 2-8 Excel workbook. It is
downloaded as a reproducible local input and fingerprinted in the audit, but is
not committed. The workbook contains suppressed, geography-level aggregates—not
the confidential child-level EDI responses—and the live dashboard's newer Wave
9 is not included in this public bulk file.

The workbook is also a different inventory vintage: it contains 299 HELP
neighbourhood rows and 47 MCFD LSA rows. In particular, it includes both `2528`
(Bella Coola Valley) and `2529` (Central Coast), while the live dashboard lists
46 LSAs and the accessible boundary service supplies 45. Treat the workbook as
published aggregate data, not as the authoritative boundary index.

The MCFD SDA and LSA catalogue records are explicitly licensed `Access Only`.
Their WFS geometry is used only for local source assessment. No source or
derived MCFD geometry is committed.

## Hierarchy and vintage findings

- HELP's shapefile provides `N_CODE`, `N_NAME`, `SD_CODE`, and `SD_NAME`, so the
  neighbourhood-to-school-district hierarchy is explicit.
- For storage, HELP neighbourhoods are the only geometry required to construct
  a same-vintage school-district approximation by dissolving on `SD_CODE`.
  Retain the official school-district layer as the canonical GEOSD geometry:
  the HELP layer has its own shoreline treatment and publication vintage.
- The published HELP shapefile contains 300 features. The live EDI dashboard
  lists 297; its list omits `N3901`, `N4410`, and `N5202`.
- MCFD LSA features contain their parent SDA and Region codes/names, while SDA
  features contain their parent Region. Region polygons can be derived by
  dissolving SDAs on `REGION_NUMBER`.
- In a complete, single-vintage MCFD source, LSA would be the only stored
  geometry needed: dissolve LSAs by their parent codes to derive SDA and Region.
  The DataBC service is not complete enough for an exact historical dashboard
  replica because it is missing `2528` and `2529`. The dashboard runtime capture
  is complete enough to derive its same-vintage SDA and Region boundaries.
- The EDI dashboard uses a historical `4 Regions -> 13 SDAs -> 46 LSAs`
  searchable hierarchy. Its rendered Leaflet map actually contains 47 LSA
  vectors, including both `2528` and `2529`; the search index omits `2529`.
  The accessible DataBC service currently returns `4 -> 13 -> 45` and omits
  both standalone historical polygons.
- An official MCFD 2013/14 report preserves the earlier 2011 map and complete
  47-LSA inventory, including both `2528` (Bella Coola Valley) and `2529`
  (Central Coast). The PDF establishes that the areas existed, but its map is an
  embedded raster rather than vector geometry. `output/index.json` therefore
  represents all 47 records as a vintage-aware index. It marks `2528`/`2529`
  as available through the dashboard runtime capture but absent from the
  current DataBC vector layer.
- The current Ministry of Health `LHA 336` Bella Coola Valley polygon was tested
  as a possible alias and rejected: only about 57.6% of it overlaps the surviving
  MCFD `2527` polygon. No cross-ministry polygon is substituted by name alone.
- MCFD's current organizational page says the 2024/25 structure is `7 SDAs ->
  44 LSAs`. No authoritative downloadable geometry for that current structure
  was found, so the older boundary service must not be labelled current.

## Geometry processing

Every polygon level is processed as a complete shared-topology layer with
Mapshaper `0.6.113` in BC Albers (`EPSG:3005`) and reprojected to WGS84 for
browser use. Tolerances are 50 m for school districts, 100 m for MCFD Regions/SDAs,
50 m for MCFD LSAs, and 25 m for HELP neighbourhoods. The audit checks feature
counts and identifiers, exact shared segments, pairwise overlaps, maximum area
change, hierarchy completeness, payload sizes, and source/output SHA-256
hashes.
