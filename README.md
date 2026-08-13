# bcdatamapper

Data scraper and scraper-related source-documentation repo split out from PGMaps.

The scripts are kept here, but their default runtime target is the sibling PGMaps
checkout. Running `npm run ...` in this repo, or through PGMaps' delegating npm
scripts, writes app-ready outputs to:

```text
/Users/ahmadjalil/github/PGMaps/public/data
```

Set `PGMAPS_ROOT=/path/to/PGMaps` to target a different PGMaps checkout.

Committed deploy snapshots for PGMaps live beside the source or scraper that owns
them, usually as:

```text
datascrapers/<domain>/output
```

PGMaps assembles those outputs into its own `public/data` directory before local
dev and GitHub Pages builds, so the browser-facing URLs remain `/data/...` while
the bulky source-controlled data is owned by this submodule. Source snapshots and
archives should stay near the scraper that owns them, for example
`datascrapers/citypg/source/public_gis`, `datascrapers/walkability/source`,
`datascrapers/transit/source`, `datascrapers/bc/flood/archive`,
`data-sources/healthdata/*/output`, and `datascrapers/native-land/snapshot`.

## Scraper Catalog

These commands are run from this repo, or through PGMaps' delegated `npm run`
commands. Scraper-owned outputs should live under `datascrapers/*/output`,
`datascrapers/*/source`, or `data-sources/*`; PGMaps assembles the browser-facing
`public/data` tree from those outputs.

| Area | Commands | Source | Main outputs |
| --- | --- | --- | --- |
| City of Prince George base layers | `citypg:sync`, `citypg:business-licences:sync`, `citypg:heat-shade:sync` | City of Prince George ArcGIS services | `public/data/citypg/`, `datascrapers/citypg/source/business-licences/`, `datascrapers/citypg/source/heat-shade/` |
| ICBC crashes | `icbc:sync` | ICBC Tableau crash workbook/data endpoints | `public/data/icbc/` |
| Heat and shade | `heat-shade:sync` | CityPG heat/shade snapshots plus Landsat metadata | `public/data/heat-shade/` |
| BC Transit GTFS | `transit:gtfs:sync` | BC Transit GTFS feed for Prince George | `public/data/transit/` and route-related CityPG road output |
| HealthyPlan PG | `healthyplan-pg:sync`, `healthyplan-pg:sync:education`, `healthyplan-pg:sync:citypg-business` | BC Data Catalogue education CSVs, CityPG-owned business licence snapshots, OSM Overpass, and BC Address Geocoder via shared mapping utilities | `datascrapers/healthyplan-pg/output/` |
| BC freshwater watersheds | `watersheds:sync`, `watersheds:dev`, `watersheds:50m`, `watersheds:assessment-50m`, `watersheds:named-50m` | BC Freshwater Atlas / watershed geospatial sources | `datascrapers/bc/boundaries/output/BCFWA/` |
| BC Snow Survey administrative basins | `snow-survey-basins:sync`, `snow-survey-basins:compare` | OGL-BC Snow Survey Administrative Basin Areas | `datascrapers/bc/boundaries/output/BCSnowSurvey/` |
| BC natural resource admin boundaries | `nr-admin:sync` | BC natural resource administrative boundary services | `public/data/boundaries/BCNRAdmin/` |
| BC Energy Regulator admin zones | `bcer-admin-zones:sync` | BCER Administrative Zones ArcGIS service | `datascrapers/bc/boundaries/output/BCER/admin_zones.geojson` |
| BC ungulate winter range | `uwr:sync` | BC UWR geospatial services | `public/data/boundaries/BCUWR/` |
| Indigenous acknowledgement support sources | `indigenous:sync` | BC CAD/PIP app and operational-service metadata, BCGW First Nation community/treaty layers, BC reserve admin boundaries, and Canada First Nations Location | `public/data/indigenous/` |
| Curated acknowledgement registry | Manual | Maintained Nation names, aliases, and relationship graph used by PGMaps acknowledgement tooling | `datascrapers/manual/output/acknowledgement/` |
| BC child care map | `bc:childcare:sync` | DataBC Child Care Map Data ArcGIS layer used by the BC child care map | `datascrapers/bc/childcare/output/` |
| BC drought | `drought:sync`, `drought:canonical` | BC drought region/status feeds | `public/data/drought/` |
| BC River Forecast Centre flood advisories | `flood:sync` | BC RFC advisory pages and documents | `public/data/flood/` |
| BC Flood Study Explorer | `flood-studies:sync`, `flood-studies:ecocat`, `flood-studies:ecocat:audit` | ClimateReadyBC Access Only study-index layer, report links, and EcoCat collections | Ignored local research cache under `datascrapers/bc/flood/studies/cache/`; no deploy snapshot without permission |
| BC Snow Survey project data | `snow-survey:sync` | Canonical Snow Survey basin boundaries plus OGL-BC manual station, automated station, and manual observation sources | `datascrapers/bc/snow-survey/output/` |
| Environmental burden source inventory | `environmental-burden:inventory` | Open Canada, BC Data Catalogue, ECCC Data Mart, DataBC WFS/ArcGIS, and COMS object storage probes for NPRI, contaminated sites, waste authorizations, groundwater, water quality, and floodplains | `datascrapers/environmental-burden/output/` |
| BC tenures | `crown-tenures:sync`, `range-tenures:sync`, `mineral-tenures:sync` | BC Crown, range, and mineral tenure geospatial services | `public/data/boundaries/BCTantalis/` and related boundary folders |
| Wildlife accident reporting | `wars:sync` | BC wildlife accident reporting data | `public/data/wars/` |
| Canada cell coverage tile sources | `cell-coverage:sync` | Rogers, TELUS, Bell, Videotron, and Freedom Mobile public coverage maps | `public/data/cell-coverage/manifest.json` |
| Canada network availability | `network-availability:sync` | CRTC, NRCan, ISED, and carrier coverage-map API findings | `public/data/network-availability/manifest.json` |
| ECCC AQMap support layers | `npm run aqmap:forecast-zones`, `npm run aqmap:fire-danger-vector`, `npm run aqmap:pm25-snapshot` from PGMaps | ECCC public standard forecast zones API, CWFIS fire danger WFS/WMS, ECCC GeoMet RAQDPS PM2.5 WMS, and ECCC Datamart RAQDPS GRIB2 | `datascrapers/eccc/output/forecast-zones.geojson`, `datascrapers/eccc/output/fire-danger-vector.geojson.gz`, `datascrapers/eccc/output/fire-danger-vector-tiles/`, `datascrapers/eccc/output/modelled-pm25-native-vector.geojson.gz`, `datascrapers/eccc/output/modelled-pm25-raster-tiles.tar.gz`, and generated `public/data/aqmap/` |
| DriveBC historical events | Manual/source archive | DriveBC historical event CSV exports | `data-sources/drivebc/historical/` |
| Native Land public metadata probe | `native-land:probe` | Native-Land.ca public map/search metadata | `data-sources/native-land/` |
| Native Land API GeoJSON bundled snapshot | `native-land:geojson`, `native-land:copy` | Native Land Digital key-gated GeoJSON API | `datascrapers/native-land/snapshot/` and `public/data/native-land/` |
| CIMD | `cimd:sync` | Canadian Index of Multiple Deprivation data joined to local census boundaries | `public/data/cimd/` |
| CANUE extracts and map layers | `canue:bc:*`, `canue:map-*`, `canue:pmtiles`, `canue:v2:*` | Local CANUE archives plus app boundary data | `public/data/canue/bc/`, `build/canue-*`, and external PMTiles/R2 outputs when requested |
| Canada administrative geographies | `canada-admin:sync`, `canada-admin:overviews`, `canada-admin:validate`, `canada-admin:pmtiles:*` | Statistics Canada CSD/CD boundaries, NRCan CLSS legal lands, and provincial overlays | `datascrapers/canada/admin-geographies/output/`, generated PMTiles, and Cloudflare R2 publication catalog |
| Census boundaries and variables | `census:sync`, `census:variables` | Statistics Canada geospatial/census vector source files | `public/data/census/` |
| BC Assessment parcels | `bc-assessment:build`, `bc-assessment:refresh` | BC Assessment ArcGIS layer plus checked-in assessment source CSV | `public/data/bc-assessment/` |
| Northern Health food inspection data | `food-health:refresh`, `food-health:geocode`, `food-health:bc-geocoder-check` | Northern Health / HealthSpace restaurant inspection pages and geocoding | `datascrapers/food-health/output/`, `datascrapers/food-health/cache/` |
| BC MSP facility map | `health:msp-facilities` | BC MSP Blue Book SQLite data joined to public BC health-service provider layers and the BC Address Geocoder | `datascrapers/health/msp-facilities/output/` |
| Walkability | `walkability:build`, `walkability:import-supplements`, `walkability:build-grid-heatmap` | CityPG layers, ICBC crashes, transit-owned stop snapshots, BC child care output, and supplemental walkability inputs | `public/data/walkability/` |

Scraper-related documentation lives in `docs/`:

- CANUE source inventory, map-layer plans, and preview images.
- DriveBC event normalization and strict bridge definitions.
- BC River Forecast Centre flood-advisory normalization and strict bridge definitions.
- Canada network availability source inventory and carrier vector/raster findings.
- [Flood Study Explorer and BC Snow Survey](docs/flood-studies-and-snow-survey.md)
  source, cache, licensing, validation, and route-index operations.
- [EcoCat display and sub-project resource audit](docs/ecocat-display-resource-audit.md)
  with content coverage, browser treatment, ZIP findings, and licensing guardrails.

Shared location helpers live under `datascrapers/bc/geocoder/`, including BC
Address Geocoder query/cache/GeoJSON helpers, Overpass queries, OSM address
extraction, and name/address matching.

## Environmental Burden Source Inventory

Use `environmental-burden:inventory` before building the full burden scrapers.
It records current catalogue resources, licences, byte-size probes, feature
counts, and usage notes for the high-value EnviroScreen inputs without bulk
downloading the large EMS/EnMoDS source files.

```bash
npm run environmental-burden:inventory
```

The command writes `datascrapers/environmental-burden/output/manifest.json` and
`datascrapers/environmental-burden/output/source-size-summary.md`. As of the
latest probe, NPRI is about 697 MB, BC waste authorizations are about 4 MB,
groundwater wells plus observation-well CSVs are about 345 MB including a
sampled spatial estimate, EnMoDS is about 3.4 GB, EMS raw CSV alternatives are
about 16 GB, the Water Quality Objectives WFS GeoJSON is about 53 MB, and
historical floodplains are about 9 MB. The Federal Contaminated Sites data ZIP
does not expose a reliable byte size from this environment; only the support
files were measurable.

## DriveBC Historical Events

The canonical historical archive is the yearly `csv.gz` files in
`data-sources/drivebc/historical/`. These are already strongly compressed while
remaining transparent source exports. Database or Parquet forms should be treated
as generated derivatives for query performance and kept out of git unless there
is a specific app-serving contract for them.

## Native Land Digital Snapshot

PGMaps reads Native Land territory, language, and treaty polygons from the
bundled bcdatamapper snapshot, not from the browser API. Copy the committed
snapshot into the app with:

```bash
npm run native-land:copy
```

Refresh the snapshot only when you have an API key and permission for the
intended use:

```bash
NATIVE_LAND_API_KEY='...' npm run native-land:geojson
```

The refresh command updates `datascrapers/native-land/snapshot/` and then copies
the files to `public/data/native-land/` in the target PGMaps checkout. The public
copy is generated and ignored by git.

## Canada Network Availability

Use `network-availability:sync` for the vector-first inventory shown in the PGMaps
MISC Network tab. It does not bulk-download the source archives; it records direct
download/API URLs, HTTP size/date metadata, geometry type, and usage notes.

```bash
npm run network-availability:sync
```

The best map-availability sources are CRTC/NRCan vector packages, not most
carrier web maps:

| Dataset | Direct source | Size | Format |
| --- | --- | ---: | --- |
| 5G Coverage | `https://web.crtc.gc.ca/cartovista/5GOverYearsYE2024_Src/5GOverYears_DL_V1.zip` | 2.5 MB | KML + MapInfo polygons |
| LTE Coverage | `https://web.crtc.gc.ca/cartovista/LTEOverTheYearsYE2024_Src/LTEOverTheYears_DL_V1.zip` | 9.2 MB | KML + MapInfo polygons |
| LTE Providers | `https://web.crtc.gc.ca/cartovista/LTEProviderCountYE2024_Src/LTEProviderCount_DL_V1.zip` | 2.4 MB | KML + MapInfo polygons |
| LTE Road Coverage | `https://web.crtc.gc.ca/cartovista/RoadsWithAndWithoutLTE_src/LTERoadsYE2024.zip` | 23.8 MB | KML + MapInfo lines |

Supporting sources:

- CRTC mobile/broadband availability CSV ZIP:
  `https://applications.crtc.gc.ca/OpenData/CASP/COMMUNICATION%20MONITORING%20REPORTS/Telecommunications%20Overview/English/data-mobile-and-broadband-availability.zip`.
- NRCan/Open Canada Wireless Data Network FGDB:
  `https://ftp.maps.canada.ca/pub/nrcan_rncan/Geographical-maps_Carte-geographique/Wireless_Data_Network-Reseau_de_donnees_sans_fil/AtlasofCanada_Communications_AtlasduCanada.gdb.zip`.
- NRCan Esri REST layer:
  `https://maps-cartes.services.geo.ca/server_serveur/rest/services/NRCan/Wireless_Data_Network_Reseau_donnees_sans_fil/MapServer/0`.
- ISED terrestrial spectrum licence site data:
  `https://www.ic.gc.ca/engineering/SMS_TAFL_Files/Site_Data_Extract_FX.zip`.

Carrier API finding: TELUS exposes public CARTO MVT coverage tiles that can be
converted to GeoJSON/PMTiles for TELUS-specific coverage. Rogers, Bell,
Videotron, and Freedom public maps expose raster PNG tiles in the inspected apps,
not clean bulk vector coverage polygons. Bell now has an explicit experimental
pipeline at `datascrapers/network/bell/` that downloads the public PNG coverage
tiles and polygonizes non-transparent pixels into approximate GeoJSON. Use
CRTC/NRCan for official national vector availability, and treat raster-traced
carrier outputs as approximate comparison layers.

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

The refresh command updates `datascrapers/food-health/output/restaurants.json`
incrementally and saves progress after each restaurant. The geocode command fills
missing coordinates in the same file. PGMaps copies that output into
`public/data/restaurants.json` during the app data sync.

Manual restaurant categories and researched coordinates are kept outside the scraped file:

- `datascrapers/food-health/output/restaurant-classifications.json`
- `datascrapers/food-health/output/restaurant-location-overrides.json`

The app merges both files at load time, so future scrape refreshes do not remove category or location corrections.
