# Census data outputs

BCDataMapper owns source-to-app data generation for census-derived layers. PGMaps consumes these files through `npm run data:sync-from-bcdatamapper`.

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

Build the full BC dissemination-block boundary chunks from `db21.shp` and the enriched crosswalk:

```bash
npm run census:bc-db-chunks -- \
  --raw-archive "/path/to/BCCDC raw archive" \
  --min-zoom 9
```

For R2/CDN hosting, bake absolute chunk URLs into the manifest:

```bash
npm run census:bc-db-chunks -- \
  --raw-archive "/path/to/BCCDC raw archive" \
  --chunk-url-base "https://<public-r2-host>/bc-db-chunks"
```

Output:

- `datascrapers/census/output/bc-db-chunks/manifest.json`
- `datascrapers/census/output/bc-db-chunks/chunks/*.geojson`

The DB boundary chunk directory is ignored by git because it is large and should be published to object storage. In PGMaps, set `VITE_BC_DB_CHUNK_BASE_URL` to the same public R2/CDN prefix when the chunks are hosted remotely.
