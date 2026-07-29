# Census data outputs

BCDataMapper owns source-to-app data generation for census-derived layers. PGMaps consumes these files through `npm run data:sync-from-bcdatamapper`.

## Canada census subdivisions and North/South classification

Build the national 2021 census-subdivision geometry and the separate
`CSDUID`-keyed Statistics Canada North/South classification:

```bash
npm run census:canada-csd
```

Outputs:

- `datascrapers/census/output/canada-csd/manifest.json`
- `datascrapers/census/output/canada-csd/provinces/*.geojson`
- `datascrapers/census/output/canada-csd/canada-csd.geojson.gz`
- `datascrapers/census/output/canada-csd/north-south.json`

Every boundary preserves its seven-digit `CSDUID` and adds `CDUID` and `PRUID`.
The province/territory GeoJSON files are the deployable map chunks, and the
deterministic gzip file is the complete national geometry snapshot. The
North/South dataset contains no geometry; PGMaps joins its `byCsdUid` values to
the shared CSD features at load time.

## BC DB to CHSA crosswalk

Build the enriched DB crosswalk and CHSA summary from the Ministry workbook, BCCDC DBF attributes, and the BCMoH boundary index:

```bash
npm run census:bc-db-crosswalk -- \
  --db-data-zip "/path/to/DB Data-20260629T213631Z-3-001.zip" \
  --raw-archive "/path/to/BCCDC raw archive"
```

Outputs:

- `datascrapers/census/output/bc_db_population_chsa_crosswalk.json`
- `datascrapers/census/output/bc_db_chsa_summary.json`

These JSON outputs are small enough to keep in BCDataMapper as the canonical app-ready crosswalk.

## BC DB boundary chunks

Build the BC dissemination-block boundary chunks from `db21.shp` and the enriched crosswalk:

```bash
npm run census:bc-db-chunks -- \
  --raw-archive "/path/to/BCCDC raw archive" \
  --min-zoom 9
```

By default this writes three map LODs:

- `overview`: simplified DB boundaries from z7 to z8.5
- `medium`: simplified DB boundaries from z8.5 to z9
- `full`: full DB boundaries from z9+

Override those thresholds/tolerances with comma-separated `id:tolerance:minZoom:maxZoom` entries:

```bash
npm run census:bc-db-chunks -- \
  --raw-archive "/path/to/BCCDC raw archive" \
  --lods overview:0.002:7:8.5,medium:0.0007:8.5:9,full:0:9:24
```

For R2/CDN hosting, bake absolute chunk URLs into the manifest:

```bash
npm run census:bc-db-chunks -- \
  --raw-archive "/path/to/BCCDC raw archive" \
  --chunk-url-base "https://<public-r2-host>/bc-db-chunks"
```

Output:

- `datascrapers/census/output/bc-db-chunks/manifest.json`
- `datascrapers/census/output/bc-db-chunks/chunks/{overview,medium,full}/*.geojson`

The DB boundary chunk directory is ignored by git because it is large and should be published to object storage. In PGMaps, set `VITE_BC_DB_CHUNK_BASE_URL` to the same public R2/CDN prefix when the chunks are hosted remotely.
