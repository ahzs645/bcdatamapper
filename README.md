# bcdatamapper

Data scraper and scraper-related source-documentation repo split out from PGMaps.

The scripts are kept here, but their default runtime target is the sibling PGMaps
checkout. Running `npm run ...` in this repo, or through PGMaps' delegating npm
scripts, writes app-ready outputs to:

```text
/Users/ahmadjalil/github/PGMaps/public/data
```

Set `PGMAPS_ROOT=/path/to/PGMaps` to target a different PGMaps checkout.

## Scraper Catalog

These commands are run from this repo, or through PGMaps' delegated `npm run`
commands. Unless noted otherwise, outputs are written into the target PGMaps
checkout under `public/data`.

| Area | Commands | Source | Main outputs |
| --- | --- | --- | --- |
| City of Prince George base layers | `citypg:sync` | City of Prince George ArcGIS services | `public/data/citypg/` |
| ICBC crashes | `icbc:sync` | ICBC Tableau crash workbook/data endpoints | `public/data/icbc/` |
| Heat and shade | `heat-shade:sync` | CityPG tree, park, forest, facility, and Landsat-related sources | `public/data/heat-shade/` |
| BC Transit GTFS | `transit:gtfs:sync` | BC Transit GTFS feed for Prince George | `public/data/transit/` and route-related CityPG road output |
| BC freshwater watersheds | `watersheds:sync`, `watersheds:dev` | BC Freshwater Atlas / watershed geospatial sources | `public/data/boundaries/BCFWA/` |
| BC natural resource admin boundaries | `nr-admin:sync` | BC natural resource administrative boundary services | `public/data/boundaries/BCNRAdmin/` |
| BC ungulate winter range | `uwr:sync` | BC UWR geospatial services | `public/data/boundaries/BCUWR/` |
| BC drought | `drought:sync`, `drought:canonical` | BC drought region/status feeds | `public/data/drought/` |
| BC River Forecast Centre flood advisories | `flood:sync` | BC RFC advisory pages and documents | `public/data/flood/` |
| BC tenures | `crown-tenures:sync`, `range-tenures:sync`, `mineral-tenures:sync` | BC Crown, range, and mineral tenure geospatial services | `public/data/boundaries/BCTantalis/` and related boundary folders |
| Wildlife accident reporting | `wars:sync` | BC wildlife accident reporting data | `public/data/wars/` |
| CIMD | `cimd:sync` | Canadian Index of Multiple Deprivation data joined to local census boundaries | `public/data/cimd/` |
| CANUE extracts and map layers | `canue:bc:*`, `canue:map-*`, `canue:pmtiles`, `canue:v2:*` | Local CANUE archives plus app boundary data | `public/data/canue/bc/`, `build/canue-*`, and external PMTiles/R2 outputs when requested |
| Census boundaries and variables | `census:sync`, `census:variables` | Statistics Canada geospatial/census vector source files | `public/data/census/` |
| BC Assessment parcels | `bc-assessment:build`, `bc-assessment:refresh` | BC Assessment ArcGIS layer plus checked-in assessment source CSV | `public/data/bc-assessment/` |
| Northern Health food inspection data | `food-health:refresh`, `food-health:geocode` | Northern Health / HealthSpace restaurant inspection pages and geocoding | `public/data/restaurants.json` |
| Walkability | `walkability:build`, `walkability:import-supplements`, `walkability:build-grid-heatmap` | CityPG layers, ICBC crashes, transit stops, and supplemental walkability inputs | `public/data/walkability/` |

Scraper-related documentation lives in `docs/`:

- CANUE source inventory, map-layer plans, and preview images.
- DriveBC event normalization and strict bridge definitions.
- BC River Forecast Centre flood-advisory normalization and strict bridge definitions.

## CANUE BC Extracts

CANUE archives should stay outside the repo. The sync script reads the local Google Drive
CANUE folder, filters annual postal-code records to BC, clips postal-code locations to
the bundled BC health-authority boundary, joins DMTI postal-code latitude, longitude,
and community fields, and writes derived CSVs plus a manifest to `public/data/canue/bc/`.

```bash
npm run canue:bc:sync
npm run canue:bc:membership
npm run canue:bc:gzip
```

Use `npm run canue:bc:sync:all-years` instead of `npm run canue:bc:sync`
when the app should expose CANUE timeline controls for datasets that ship
multiple annual files.

Use `npm run canue:bc:sync:all-cadences -- --source "/path/to/2026 pull"`
for the flat 2026 CANUE pull when monthly files should also be imported.
Monthly files stay as raw monthly columns in the derived CSVs; the app can show
a single month, a year average, an all-years average, or a year-range average.
Use `npm run canue:bc:sync:monthly` for the lighter monthly-only path; it writes
gzip files directly and avoids the large uncompressed intermediate CSV folder.

By default, the script uses the local CANUE path under Google Drive and extracts the latest
available year from each annual archive. Override the source or year selection when needed:

```bash
PG_CANUE_DIR="/path/to/Canue" npm run canue:bc:sync
node datascrapers/canue/sync-canue-bc.mjs --years 2016,2019,2021
node datascrapers/canue/sync-canue-bc.mjs --all-years
node datascrapers/canue/sync-canue-bc.mjs --all-years --cadence both --source "/path/to/2026 pull"
node datascrapers/canue/sync-canue-bc.mjs --all-years --cadence monthly --gzip true --source "/path/to/2026 pull"
node datascrapers/canue/sync-canue-bc.mjs --all-years --cadence both --include "pm25dal*,aqsmk_*"
node datascrapers/canue/sync-canue-bc.mjs --boundary-path none
```

The uncompressed generated CSVs under `public/data/canue/bc/annual/` are local
working files and are ignored by git. The membership step writes a reusable
postal-code-to-boundary lookup for the study-area selector. The gzip step writes
app-ready compressed raw extracts to `public/data/canue/bc/annual-gzip/`; the
app joins through the membership lookup and aggregates records into the selected
map boundaries in the browser.

## BC Assessment Data

BC Assessment parcel geometries can be rebuilt from the checked-in source files or
refreshed from the current `bcassessment.ca` ArcGIS layer for Prince George
jurisdiction `226`.

```bash
pip install -r datascrapers/bc/assessment/requirements.txt
npm run bc-assessment:build
npm run bc-assessment:refresh
```

The refresh command updates `datascrapers/bc/assessment/source/prince_george_parcels.geojson`
and then rebuilds `public/data/bc-assessment/parcels.geojson`. It converts Esri
polygon rings into valid GeoJSON `Polygon`/`MultiPolygon` geometries and applies
a Shapely validity repair fallback for self-intersections. The detail CSV remains
`datascrapers/bc/assessment/source/prince_george_full.csv`; the live map layer does not
include every detail field used by the app.

## Food Safety Data

Northern Health Authority HealthSpace food inspection data can be refreshed from this repo.

```bash
python3 -m venv .venv-food-health
source .venv-food-health/bin/activate
pip install -r datascrapers/food-health/requirements.txt
npm run food-health:refresh
npm run food-health:geocode
```

The refresh command updates `public/data/restaurants.json` incrementally and saves progress after each restaurant. The geocode command fills missing coordinates in the same file.

Manual restaurant categories and researched coordinates are kept outside the scraped file:

- `public/data/restaurant-classifications.json`
- `public/data/restaurant-location-overrides.json`

The app merges both files at load time, so future scrape refreshes do not remove category or location corrections.
