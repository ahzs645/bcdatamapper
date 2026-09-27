# State of the North: extraction inventory

```sh
npm run state-of-north:inventory
npm run state-of-north:samples
npm run test:state-of-north
```

The [NDIT dashboard](https://www.northerndevelopment.bc.ca/state-of-the-north/)
embeds a public Power BI publish-to-web report. A read-only probe confirmed
that its published model, chart definitions, field schema and bounded table
queries are retrievable without an account. The resource key is the report's
public identifier, not an account credential. The underlying endpoints are
undocumented and may change; failures should be surfaced, not silently replaced
with stale or empty data.

The inspected model was refreshed **2026-04-30 16:52 UTC**. It contains 25 pages:
20 indicator pages, one narrative overview and four tooltip pages. The inventory
records 41 referenced model entities, including measures, filter/control tables
and narrative data; these are not 41 independent statistical datasets.

`output/inventory.json` contains each page's visuals, titles, source subtitles,
table names and selected fields. It also identifies every extraction pilot and
whether the response reached the 5,000-row cap. An inventory-only run does not
re-query the pilots and writes an empty samples list.

## What else is available

| Area | Additional data and practical map use |
| --- | --- |
| Mining | Mine name, operator, type, commodities, operating status, nearest community, latitude/longitude and Northern BC flag: point layer candidates. |
| Clean energy | Independent power project name, seller, location, technology, procurement process, MW capacity, GWh/year and NDIT region; generating stations and capacity. IPP rows include places outside Northern BC and have no coordinates. |
| Tourism and transport | Airport passengers; ferry passengers and vehicles by route/month; room revenue subject to MRDT by place/month. Route labels are not route geometries. |
| Housing | City housing-price history with coordinates, rental rates by dwelling type/location and housing starts. Price table history begins earlier than 2017. City points do not imply municipal-area coverage. |
| Forestry | Harvest billings, lumber production, softwood exports, Prince Rupert cargo, timber-processing facility counts/capacity. Counts are not a geocoded facility inventory. |
| Agriculture | Crop/animal farm counts, active/inactive classification and crop production. Data frequency varies; census tables are not annual surveys. |
| Labour and business | Quarterly vacancies/rates, employment/participation/unemployment, industry employment, business counts with/without employees, incorporations, consumer/business bankruptcies and three-year trends. |
| People | Historical/forecast population by age, migration components, median income and low-income share. Keep forecasts distinct from observations. |
| Provincial comparisons | GDP by industry and real growth, exchange-rate history/forecasts. Do not attach province-wide values to individual economic regions. |

Useful source table references in chart subtitles: Statistics Canada
36-10-0402 (GDP), 14-10-0462 (labour force), 14-10-0398 (vacancies),
17-10-0151 (migration) and 16-10-0017 (lumber).
Use original source feeds where possible, retaining NDIT/MNP-specific
aggregation definitions when reproducing the dashboard.

## Verified extraction pilots

Seven compressed JSON files retain selected source columns and reference dates:

| Table | Distinct rows retrieved | Completeness |
| --- | ---: | --- |
| BC mines | 25 | Complete returned table projection |
| Independent power producers | 850 | Complete returned table projection; multiple years |
| Generating capacity | 11 | Complete returned table projection |
| Housing prices | 5,000 | **Capped sample**, not the full series |
| Ferry traffic | 402 | Complete returned table projection |
| Tourism room revenue | 687 | Complete returned table projection |
| Job vacancies | 866 | Complete returned table projection |

The queries request distinct source-table rows. They do **not** reproduce chart
measures, filtering, regional totals or DAX calculations. Null values are retained
as null, dates decoded to ISO UTC, and both repeated-value and dictionary-encoded
cells are decoded. A reached row cap is recorded explicitly. Housing would need
date-partitioned requests or continuation handling for a complete extraction.
These pilots are source research artifacts, not a production economic dashboard.

## Geography and reuse

Economic regions, NDIT service regions, regional districts, cities, routes,
individual facilities and BC totals coexist. Do not join by a generic `Region`
label. See [economic-region hierarchy](../boundaries/ECONOMIC-REGIONS.md).
NDIT's report-year selection may fall back to an earlier data year. Preserve the
model refresh date, actual reference date, unit, geography and forecast status.
Geocoded mine records still need validation against the original mine source
before treating their status as current.

The [launch FAQ](https://www.northerndevelopment.bc.ca/news/northern-development-launches-digital-state-of-the-north-dashboard/)
explicitly permits research reuse of this public dashboard. Preserve original
source attribution and check source-specific terms for production redistribution;
this is separate from the other NDIT product, NEDD, which uses a proprietary
macroeconomic model. No NEDD data is acquired here.
