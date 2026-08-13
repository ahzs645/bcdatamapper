# Canada administrative geographies

This scraper owns the national boundary foundation for the proposed PGMaps
Canada local-government atlas. It deliberately preserves the distinction
between governments and statistical equivalents.

## Download

```bash
npm run canada-admin:sync
npm run canada-admin:overviews
npm run canada-admin:validate
npm run canada-admin:pmtiles
```

Use `npm run canada-admin:sync -- --resume` to reuse valid completed snapshots
after an interrupted run. The sync accepts `--skip-csd`, `--skip-cd`, and
`--skip-indigenous` only when the corresponding entry already exists in the
top-level output manifest. `--skip-provincial` similarly reuses the completed
provincial overlay entry.

## Outputs

Full-detail, deterministic gzip snapshots:

- `output/national/census-subdivisions-2025/provinces/*.geojson.gz`
- `output/national/census-divisions-2021/provinces/*.geojson.gz`
- `output/national/indigenous-lands-clss.geojson.gz`
- `output/provincial/newfoundland-labrador/*.geojson.gz`
- `output/manifest.json`

App-facing derived layers:

- `output/overview/census-subdivisions-2025.geojson`
- `output/overview/census-divisions-2021.geojson`
- `output/overview/census-divisions-2025-derived.geojson`
- `output/overview/indigenous-lands-clss.geojson`
- `output/reference/statcan-geography-types-2025.json`

The CSD source reflects boundaries in effect on January 1, 2025. A CSD is a
municipality or a statistical municipal equivalent. The CD source is the 2021
Census comparison layer; a CD can be a regional government or a statistical
equivalent. Neither layer may be relabelled wholesale as a government layer.
The derived 2025 CD layer dissolves current CSD polygons on their supplied
parent `CDUID`; this captures the 12 New Brunswick Regional Service Commissions
that replaced the 15 county-shaped 2021 census divisions.

The CLSS layer contains several legal distribution types. The normalized files
retain those types and must not collapse Indian reserves, Inuit Owned Lands,
Yukon First Nations Settlement Lands, Tlicho Lands, or other settlement lands
into a single category.

`sources.json` is the acquisition ledger. Entries marked `automated` or
`existing-scraper` are reproducible now. `candidate` entries still require an
endpoint/licence/schema review before their provincial data can become a
canonical snapshot.

## PMTiles and Cloudflare R2

Build five validated, app-facing PMTiles archives and the publication catalog:

```bash
npm run canada-admin:pmtiles
```

The archives are generated under the ignored local directory
`build/canada-admin-pmtiles`. The small catalog is scraper-owned output at
`output/r2/pmtiles-catalog.json`, so PGMaps receives it through the normal
`data:sync-from-bcdatamapper` assembly step.

Publish to the repository's `maps` Cloudflare R2 bucket using the authenticated
Wrangler v4 session:

```bash
npm run canada-admin:pmtiles:publish
```

Versioned archives are immutable beneath
`canada/admin-geographies/v2025-01-01/`. The short-cache catalog is published
at `https://data.map.ahmad.sh/canada/admin-geographies/catalog.json`. The
catalog retains source-layer names, feature counts, roles, licences, hashes,
bounds, zoom ranges, and public archive URLs.
