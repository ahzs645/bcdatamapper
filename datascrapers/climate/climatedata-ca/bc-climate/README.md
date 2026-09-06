# BC-wide Northern Health climate-source pipeline

**Code/recipes in BC Data Mapper; all source and generated data in R2.**
The ignored `cache/` and `output/` directories are working storage only. Do not
force-add them, put these layers under PGMaps `public/data`, or add a data sync
rule. The frontend reads the R2 catalogue and visible grid blocks at runtime.

Catalogue: <https://data.map.ahmad.sh/climate/bc-climate-u6/latest.json>

## Scope

The supplied Northern Health facilities report contains 16 climate indicators.
This release provides their **whole-BC gridded inputs**, not just Northern Health
or Prince George. It is not a mirror of every dataset served by PAVICS.

| Report indicator | Product / season | Source |
|---|---|---|
| Mean annual temperature | `tg_mean` | CanDCS-U6 |
| Cooling degree days >18°C | `ccdcold_18` | CanDCS-U6 |
| Heating degree days <18°C | `hddheat_18` | CanDCS-U6 |
| Days >29°C | `txgt_29` | CanDCS-U6 |
| Hottest day | `tx_max` | CanDCS-U6 |
| Coldest night (report: minimum annual temperature) | `tn_min` | CanDCS-U6 |
| Nights >18°C | `tr_18` | CanDCS-U6 |
| Frost days | `frost_days` | CanDCS-U6 |
| Ice days | `ice_days` | CanDCS-U6 |
| Frost-free season | `frost_free_season` | CanDCS-U6 |
| Annual precipitation | `prcptot` | CanDCS-U6 |
| Winter precipitation | `prcptot_seasonal` / `winter` | CanDCS-U6 |
| Summer precipitation | `prcptot_seasonal` / `summer` | CanDCS-U6 |
| Maximum 1-day precipitation | `rx1day` | CanDCS-U6 |
| Maximum 5-day precipitation | `rx5day` | CanDCS-U6 |
| Annual precipitation as snow | `PAS` | Archived ClimateBC |

Also retained: `txgt_32`, `tn_mean`, `tx_mean`, and spring/autumn precipitation.
That is 18 product files representing 21 indicator/season choices. U6 covers all
13 supplied 30-year horizons, 1951–1980 through 2071–2100, p10/p50/p90, absolute
values, and the source's delta ensembles for baselines 1971–2000 and 1991–2020.
The report's default periods are 1971–2000, 2041–2070 and 2071–2100. PAS has four
archived periods: 1971–2000, 2011–2040, 2041–2070 and 2071–2100; no percentiles.
The scenario is SSP585. Other scenarios, CMIP5/U5 and newer M6 products are **not**
silently substituted.

The regional population-weighted tables require separate Census 2021
dissemination-block populations and HA/HSDA aggregation; facility tables require
point sampling. They are not equivalent to grid-cell or area-weighted means and
are not claimed as recreated here. Hospitals, watersheds and health boundaries
remain their existing independently owned layers, not duplicate climate assets.

## Run

Python >=3.12, `uv`, and Node >=20 are recommended. Dependencies are pinned in
`requirements.txt`. From BC Data Mapper (as the initialized PGMaps submodule):

```bash
# First run: downloads 17 NetCDFs directly from PAVICS. Snow restores from R2.
# Before the first publication only, supply the local Climate Data archive root.
npm run climatedata:bc:pipeline

# Publish after verifying local output. Existing Wrangler login or a scoped
# CLOUDFLARE_API_TOKEN with R2 write access; never put credentials in the recipe.
npx wrangler@4.71.0 whoami
npm run climatedata:bc:pipeline -- --upload --wrangler-auth

# Individual resumable stages:
npm run climatedata:bc:acquire
npm run climatedata:bc:build
npm run climatedata:bc:publish -- --upload --wrangler-auth

# Restore exact upstream originals without PAVICS or Google Drive:
npm run climatedata:bc:acquire -- --restore
# For a pinned historical release, add --source-manifest URL pointing to that
# immutable release's sources.json, rather than the mutable default pointer.
```

On a standalone checkout or PAVICS Jupyter terminal, bypass `run-in-pgmaps.sh`:

```bash
uv run --with-requirements datascrapers/climate/climatedata-ca/bc-climate/requirements.txt \
  python datascrapers/climate/climatedata-ca/bc-climate/pipeline.py
```

The same Python entry points can run on a Jupyter server; no server connection
or account is required for public THREDDS downloads. Keep publication credentials
out of notebooks and their outputs. This task has not logged into PAVICS Jupyter.

Acquisition discovers the unique `*_30ymean_percentiles.nc` in each THREDDS XML
catalogue under `birdhouse/disk3/.../BCCAQv2_CMIP6/`. Old disk2 URLs are obsolete.
It records original URLs, byte sizes and SHA-256 hashes. Subsequent acquisitions
enforce the cached source hashes unless `--refresh` explicitly accepts upstream
changes. `--restore` verifies every R2 source part and the reassembled file hash.
ClimateBC snow is imported from the supplied Northern Health archive once, then
restored from R2; it is never silently replaced with the newer ClimateBC release.

## Geometry and numerical contract

- BC extent uses the existing regional-district polygons (including Stikine)
  **plus Northern Rockies Regional Municipality** from the existing municipal
  collection. Regional districts alone omit Northern Rockies. Both source hashes
  are recorded, and nine coverage checkpoints protect the north, islands and
  southern/interior BC against accidental truncation. No new boundary data is
  embedded in this directory.
- The derived provincial outline fills internal holes from inland waters,
  administrative exclusions and precision seams between the two collections.
  Exterior rings are unchanged; filling is rejected if it increases area by
  more than 0.1%. This cleanup does not edit the canonical administrative zones.
- Every native grid cell intersecting that union is retained, including border
  cells. Cell footprints are **not geometrically clipped**; they can extend just
  outside BC. Use the supplied BC outline/mask if strict display clipping is needed.
- All-touched selection is computed with exact cell/polygon intersections, not a
  centre-only mask. BC coverage does not manufacture observations: source NaN and
  gaps stay missing, and source rasters are never extrapolated.
- Native axes supply shared rectangle edges. No independent polygon simplification,
  resampling, smoothing, contouring, rounding or quantization is performed.
- Stable cell IDs are `grid:row:column` on the original source grid. Shared edges
  are identical by construction, and interiors of distinct cells do not overlap.
- Absolute Kelvin temperatures become °C by subtracting 273.15. Kelvin temperature
  *differences* are unchanged. Float64 output preserves source precision; PAS
  Float32 values are represented exactly in Float64. NaN is the missing marker.
- `txgt_29` is **>29°C**, not the older UI label >30°C. `tn_mean` is not `tn_min`.
- Some precipitation arrays label units `mm day-1` despite their description as
  accumulated totals. Values are unchanged, with `sourceUnits` retained; display
  units follow the indicator description/report (mm). This metadata inconsistency
  is exposed in `unitNote`, not hidden through an invented rate conversion.
- CF dates identify seasons: March/spring, June/summer, September/autumn,
  December/winter. Array order is never assumed to start with winter.
- Source delta percentiles are preserved. Do not subtract marginal percentiles
  and claim that result is the source's percentile of model changes.

## Deck.gl format and consumption

The format is `bcdatamapper-native-grid-v1`, with no WMS dependency:

```text
latest.json -> releases/<content-derived-id>/manifest.json
  grids/<grid>.json                 axes, tile bounds, counts
  grids/<grid>/<tile>.json.gz        native within-block cell indices
  products/<indicator>.json          band selectors, units, ranges, tile paths
  values/<indicator>/<tile>.f64.gz   gzip Float64 little-endian values
  bc-boundary.geojson                full BC outline
  sources.json -> sources/<sha>/...  exact upstream files, 64 MiB parts
  checksums.json / validation.json   audit results
  deckgl.mjs / preview.html          adapter and interactive vector preview
```

Blocks are 128×128 native cells before the BC mask. Geometry is shared across
products. A value file contains all bands for its block, in band-major order:
`offset = (bandIndex * tile.count + cellIndex) * 8`. Its cell ordering is the
grid tile's `indices` array. Every band carries its horizon, percentile, measure,
baseline, season, source units and output units. The browser adapter explicitly
decodes little-endian doubles and skips NaN; it does not require `loaders.gl`.

```js
import {GeoJsonLayer} from '@deck.gl/layers';
import {openClimate} from './deckgl.mjs';

const climate = await openClimate(
  'https://data.map.ahmad.sh/climate/bc-climate-u6/latest.json'
);
const layers = [];
for await (const tile of climate.visibleTiles('txgt_29', {
  horizon: '2071-2100', percentile: 'p50', measure: 'absolute', season: 'annual'
}, [-124, 53, -121, 55], {signal: abortController.signal})) {
  layers.push(new GeoJsonLayer({
    id: `climate-${tile.id}`, data: tile.data, pickable: true,
    filled: true, stroked: false,
    getFillColor: feature => colourScale(feature.properties.value)
  }));
}
```

Supply current viewport bounds and cancel stale loads. Keep separate layers per
block. The adapter has a bounded 24-entry LRU cache. Snow contains ~2.1 million
cells; use viewport loading at zoom 7+ (as the preview does), not one full-BC
GeoJSON. The preview legend shows the selected band's BC-wide min/max; it is a
numeric colour scale, **not an asserted health-risk classification**.

`.gz` objects use `application/gzip` without `Content-Encoding`; the adapter also
accepts a server that automatically decodes gzip. R2 objects require public GET
and CORS for the map origin. This pipeline uses the existing `maps` bucket and
`data.map.ahmad.sh`; it does not change bucket policies or provision credentials.

## Publication and validation

`publish.py` is dry-run unless `--upload` is provided. It validates every local
artifact's hash, uploads only within `climate/bc-climate-u6`, then reads each
object back over the public URL and verifies its SHA-256. An ignored local
publication journal supports resuming. `--reverify` rechecks journaled objects.
Only after the entire release succeeds are the source pointer and `latest.json`
updated. Immutable releases remain available for rollback by their manifest URL;
the publisher never deletes old releases or other bucket contents.

Raw source files are preserved byte-for-byte in content-addressed 64 MiB parts,
including full upstream geographic coverage. The browser products are BC-only.
This preserves provenance and allows exact reconstruction even if THREDDS paths
move again. R2 storage is not a daily-series reconstruction of model ensembles:
the authoritative inputs here are the supplied precomputed 30-year statistics.

```bash
uv run --with-requirements datascrapers/climate/climatedata-ca/bc-climate/requirements.txt \
  python -m unittest discover -s datascrapers/climate/climatedata-ca/bc-climate -p 'test_*.py'
node --test datascrapers/climate/climatedata-ca/bc-climate/deckgl.test.mjs

# Optional browser check: run with PGMaps' @playwright/test and Chrome installed.
node datascrapers/climate/climatedata-ca/bc-climate/browser-test.mjs
```

The builder checks all 21 input hashes, source completeness, identical grid axes,
CF seasons, exact output round-trip values, missing-value counts, and ranges.
The release ID hashes recipe, source hashes, boundary hash and builder/adapter
code. Gzip timestamps are zero, JSON keys sorted, and no run timestamps are
inserted into data files. Repeat builds should produce identical checksums.

Attribution: PCIC / ClimateData.ca / PAVICS (CanDCS-U6, BCCAQv2 CMIP6 calibrated
against ANUSPLIN300); ClimateBC, University of British Columbia (CC-BY). The report
identifies ClimateBC v7.41; the actual archived file hashes are authoritative and
that version has not been independently established from embedded raster tags.
See [PCIC dataset/terms](https://www.pacificclimate.org/data/statistically-downscaled-climate-scenarios),
[ClimateData.ca terms](https://climatedata.ca/about/legal/terms/) and
[ClimateBC licensing](https://climatebc.ca/). Retain upstream attributions and
source-specific terms; these derived layers are not endorsed by the providers.
