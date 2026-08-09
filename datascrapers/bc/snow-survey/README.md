# BC Snow Survey

The complete source, licensing, output, validation, and route-index record is in
[`docs/flood-studies-and-snow-survey.md`](../../../docs/flood-studies-and-snow-survey.md).

This scraper builds a compact, reproducible snapshot for a future **BC Snowpack**
project from the three underlying BCGW datasets, which are individually licensed
under the Open Government Licence – British Columbia.

```bash
npm run snow-survey:sync
```

Outputs in `output/`:

- `manual-stations.geojson` — active and inactive manual snow courses.
- `automated-stations.geojson` — active and inactive automated stations.
- `stations.geojson` — combined station index with basin assignment and live links.
- `manual-current.csv` — current-season manual observations.
- `manual-archive.csv.gz` — deterministic compressed historical observations.
- `station-series-index.json` — station metadata without geometry for project UI.
- `basin-project-index.json` — route-ready child-project summaries and aliases.
- `manifest.json` — source, licence, counts, byte sizes, and SHA-256 checksums.

Snow Survey Administrative Basins are snow-program reporting areas. They are not
Freshwater Atlas watershed boundaries and must not be substituted for them. FWA
boundaries can be shown as optional hydrologic context in a project.

The polygon layer is owned once as the canonical boundary dataset at
`datascrapers/bc/boundaries/output/BCSnowSurvey/snow_survey_admin_basins.geojson`.
`snow-survey:sync` refreshes that boundary first, uses it for point-in-polygon
station assignment and basin bounds, and writes its dataset and feature IDs into
`basin-project-index.json`. It does not write a duplicate polygon file here.

The station layer includes outbound Real-Time Water report/data URLs derived from
the Province's official interactive map. Live automated observations are not
mirrored. The manual observation CSV has depth, snow water equivalent, density,
date, and survey period, but no percent-normal column. Basin percent-normal values
need a separate dated bulletin source or a documented climatology calculation.

Sources and licences:

- [Snow Survey page](https://www2.gov.bc.ca/gov/content/environment/air-land-water/water/water-science-data/water-data-tools/snow-survey-data)
- [Interactive map](https://governmentofbc.maps.arcgis.com/apps/webappviewer/index.html?id=c15768bf73494f5da04b1aac6793bd2e)
- [Snow basins (OGL-BC)](https://catalogue.data.gov.bc.ca/dataset/9ec01cdb-7085-44fe-b059-9fe5aefb7497)
- [Manual stations (OGL-BC)](https://catalogue.data.gov.bc.ca/dataset/9f653102-5627-45a7-bd4c-686e365ee04a)
- [Automated stations (OGL-BC)](https://catalogue.data.gov.bc.ca/dataset/ebe546aa-ac34-491c-a828-fdc87fb70610)
- [Current manual observations (OGL-BC)](https://catalogue.data.gov.bc.ca/dataset/12472805-6f6d-457b-8db2-5c1f42a00099)
- [Archived manual observations (OGL-BC)](https://catalogue.data.gov.bc.ca/dataset/705df46f-e9d6-4124-bc4a-66f54c07b228)

## Project direction

A **BC Snowpack** project can use the basins as the primary navigation layer and
the stations as selectable evidence. The initial project can show active/inactive
status, station type, elevation, operator, camera availability, current manual
depth/SWE, and historical charts. Basin summaries should aggregate only documented
measurements; percent-normal requires a dated bulletin feed or an explicit baseline
calculation. The two Yellowhead stations currently fall outside the published snow
basin polygons and remain unassigned rather than being forced into a basin.

Canonical child routes use readable kebab-case slugs, for example
`/bcsnowpack/upper-columbia`. Compact aliases such as
`/bcsnowpack/uppercolumbia` are emitted too, so old/shared links can resolve and
redirect to the canonical route.
