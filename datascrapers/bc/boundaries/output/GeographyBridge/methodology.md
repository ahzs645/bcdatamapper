# Connecting BC's economic, census and health geographies

Run `python3 datascrapers/bc/boundaries/geography-bridge/build.py` from BCDataMapper.
Run `python3 -m unittest discover -s datascrapers/bc/boundaries/geography-bridge -p 'test_*.py'`.
No network requests or new packages are needed. Inputs and output ownership stay
in BCDataMapper; PGMaps' existing boundary sync copies output/GeographyBridge.

## What this release connects

The stable joining unit is the **2021 census dissemination block (DB)** in the
existing Ministry/BCCDC DB–CHSA crosswalk. Each of 52,387 DB records has a census
DA, CSD and CD, a CHSA assignment and population/dwelling counts. We join its CD
and CSD to Statistics Canada's official 2021 economic-region classification.
Both membership paths must agree. Economic and health sources remain separate
in the selector; this bridge links their identifiers independently of the UI.

```
BC → economic region → census division → census subdivision
                                            ↑
                                  2021 census block → CHSA → LHA → HSDA → HA
                                            ↓
                                  dissemination area
```

These arrows show the source membership relations; they do not assert that a
whole census subdivision or dissemination area fits inside one health area.
DBUID/DAUID/CDUID/CSDUID and official ER codes are strings. Do not infer a parent
from a code prefix or a similar name. We validate CSD/CD/ER agreement for every DB.
A CT is deliberately not included: the input contains pseudo-tract codes outside
tract coverage. The bridge does not imply a universal DA→CT hierarchy.

## Files and joins

- `blocks.json.gz`: one row per DB, with census and health IDs, 2021 counts and
  `healthLinkStatus`. Join on `dbuid`; join other tables using the explicit field.
- `relationships.json.gz` / `relationships.csv.gz`: 12 comparisons (ER, CD or CSD
  versus CHSA, LHA, HSDA or HA). Filter `censusLevel` and `healthLevel` **before**
  summing. Each comparison accounts for every source DB once, including null
  health-parent groups. Rows contain DB count, population, dwellings, households,
  and population shares in both directions. Shares are fractions from 0 to 1.
- `economic-region-profiles.json`: eight compact records for the story's live
  attribute join on `ERUID` ↔ `economicRegionCode`. Click a region for its links
  and unresolved counts. No geometry is changed or regenerated.
- `dashboard-registry.json`: all 41 published model entities and their fields,
  report pages, extraction state and reviewed joining guidance for seven pilots.
  Date/measure/control entities are not independent statistical datasets.
- `job-vacancies-linked.json.gz`: all 866 pilot observations retained once,
  carrying their original fields and a separate geography object.
- `manifest.json`: input SHA-256 hashes, source DB metadata, counts, code-set
  differences, model refresh date and interpretation limits.

Example: Prince George CSD `5953023` → Fraser-Fort George CD `5953` → Cariboo ER
`5950`. Its source block records carry CHSA assignments which lead to Prince
George LHA `524`, Northern Interior HSDA `52`, Northern HA `5`. Other Cariboo
blocks link to other health authorities. One economic region is not one HA.

## Coverage is explicit

The bridge covers all 751 CSD IDs in the official 2021 BC membership table and
5,000,874 residents in the **input block universe**. This is not a new official
province population estimate. The input reports 36 extra population DB rows
outside its crosswalk; they remain outside this release rather than being guessed.

All blocks have a CHSA code, but **533 blocks / 78,916 residents** have CHSA `2210`
and no LHA, HSDA or HA parent in the input. We retain these records and null
parents. They are not silently assigned by centroid, name or code prefix.
The local boundary index has 231 CHSAs while the DB crosswalk has 218 distinct
codes; 14 index codes are absent from the DB crosswalk and one DB code is absent
from the index. The index does not establish a health-boundary vintage, so it is
not labelled as 2021. A dated official concordance is needed to reconcile this.
Map health polygons are illustrative context from that index's snapshot; they
are not used to recompute or repair the source assignments.

## Population shares are not universal allocation weights

`populationShareOfCensus` uses all covered population in the census area,
including people whose health parents are unresolved. `populationShareOfHealth`
uses all covered population in that health area. Zero-population denominators
return null; unresolved health parents have no health-side share. DB memberships
are source assignments, not measured geometric intersection areas.

Use counts for descriptive roll-ups within the covered universe. To allocate a
new count across boundaries, first justify the population-based assumption and
label the result as estimated. Jobs, mine production, power capacity and tourism
activity do not necessarily follow residents. Recalculate rates from compatible
numerators and denominators. Do not sum rates, duplicate grouped observations,
or average medians into a purported aggregate median.

## Connecting the State of the North dashboard

Each observation should retain a table/dataset ID, geography type and ID(s),
reference period, unit, dimensions, measure, source refresh and observed/forecast
status when those are supplied. Missing metadata stays missing. A report-year
selector and a source observation date are different. This release uses the
previously inspected model refreshed 2026-04-30; it does not claim a live refresh.

The vacancy pilot's **explicit, table-specific aliases** connect B.C. to province
59, Cariboo to ER 5950, Northeast to ER 5980, and North Coast and Nechako to a
group containing ERs 5960 and 5970. A group observation remains one row, not two.
`Northern B.C.` remains `definition-unverified`; its footprint must be verified
from that table's methodology. NDIT service regions are separate from economic
regions and must never be equated through a generic Region label.

Other pilots are registered but not falsely labelled as fully connected:

| Pilot | Needed before geographic integration |
| --- | --- |
| Mines | Validate coordinates/status; spatially assign the facility with boundary vintage and ambiguous-edge handling. Nearest town is not jurisdiction. |
| Independent power projects | Verify facility locations/IDs; NDIT regions are a separate crosswalk. |
| Generating capacity | Resolve station IDs and the definition of any regional total. |
| Housing prices | Complete the capped extraction and establish market-area coverage; a city point is not a coverage polygon. |
| Ferry traffic | Verify route and terminal IDs; retain route geography. |
| Tourism revenue | Reconcile MRDT reporting areas and dates; a place name alone is insufficient. |

Schema-only candidates include population and age forecasts, migration, rents,
housing starts, labour force, industry employment, businesses, bankruptcies,
incorporations, forestry, agriculture, airports, GDP and exchange rates. Review
each table's geography and measures before adding a connector. Provincial GDP
stays provincial; forecasts stay distinct from observations.

## Sources

- [Official 2021 SGC economic-region classification](https://www23.statcan.gc.ca/imdb/p3VD.pl?CLV=2&CPV=59&CST=01012021&CVD=1368932&Function=getVD&MLV=5&TVD=1368923).
- Existing `datascrapers/census/output/bc_db_population_chsa_crosswalk.json`, whose
  manifest names the Ministry DB_CHSA_Crosswalk_2021 workbook, BCCDC DBF inputs
  and BCMoH hierarchy index. Their source provenance is copied into this manifest.
- [State of the North](https://www.northerndevelopment.bc.ca/state-of-the-north/),
  NDIT/MNP; inventory and pilot snapshots in `datascrapers/bc/state-of-north`.

The public Power BI extraction endpoint is undocumented. Prefer official source
feeds when implementing scheduled refreshes; retain NDIT-specific grouping
methodology and check upstream reuse terms. No new dashboard extraction, new
boundary vintage, health-parent repair or economic-to-health indicator estimate
is claimed by this release.
