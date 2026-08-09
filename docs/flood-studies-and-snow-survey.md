# Flood Studies and BC Snow Survey source operations

This document records the source, licensing, local-cache, synchronization, and
validation decisions for the ClimateReadyBC Flood Study Explorer and the BC Snow
Survey datasets. Product routing and PGMaps workspace integration are documented
in `PGMaps/docs/flood-studies-snowpack-subprojects.md`.

Status date: 2026-08-08.

## Ownership summary

| Dataset | Licence | Canonical location | May be committed? |
| --- | --- | --- | --- |
| Flood Study Explorer geometry and attributes | Access Only | `datascrapers/bc/flood/studies/cache/` | No; local research cache only |
| Flood reports and EcoCat attachments | Access Only source record; documents may also have third-party terms | `datascrapers/bc/flood/studies/cache/` | No; local research cache only |
| Snow Survey Administrative Basins | OGL-BC | `datascrapers/bc/boundaries/output/BCSnowSurvey/` | Yes |
| Manual Snow Survey Site Locations | OGL-BC | `datascrapers/bc/snow-survey/output/` | Yes |
| Automated Snow Weather Station Locations | OGL-BC | `datascrapers/bc/snow-survey/output/` | Yes |
| Current and archived manual observations | OGL-BC | `datascrapers/bc/snow-survey/output/` | Yes |
| Real-Time Water reports and live station pages | Separate live service | Outbound URLs in the station index | Links only; not mirrored |

The umbrella Snow Stations Interactive Map is Access Only. Its three underlying
BC Geographic Warehouse layers and two manual-observation datasets have their own
OGL-BC catalogue records. The underlying OGL records—not the umbrella application
record—are the authority for committed Snow Survey snapshots.

## Flood Study Explorer

### Sources

- Explorer: <https://climatereadybc.gov.bc.ca/pages/flood-study-explorer>
- BC Data Catalogue: <https://catalogue.data.gov.bc.ca/dataset/2ca51dd6-cad1-455f-b772-ad770682be09>
- ArcGIS item: <https://www.arcgis.com/sharing/rest/content/items/33f295ff4df543c693210b5bf093fc36?f=pjson>
- Feature layer: <https://services1.arcgis.com/xeMpV7tU1t4KD3Ei/arcgis/rest/services/Flood_Studies_FGDB_20260331_164628_view/FeatureServer/0>
- Legacy EcoCat: <https://a100.gov.bc.ca/pub/acat/public/>

The layer currently has 166 unique `Project_ID` records: 139 polygons and 27
multipolygons. It includes title, date, proponent, consultant, FCL classification,
proponent-hosted report URL, provincial report-package URL, and a report-data
package placeholder.

The geometry must be described as **source-defined study-index/coverage geometry**,
not as flood extent, inundation extent, or hazard polygons. Official metadata is
internally inconsistent:

- ArcGIS describes the polygons as the total area covered by a study.
- The BC Data Catalogue says a study may be mapped from the proponent location
  and may not represent the study location.

Any production use must display that limitation and avoid spatial conclusions
until a study's geometry is verified against its documents.

### Inventory and capped report download

Run:

```bash
npm run flood-studies:sync
npm run flood-studies:sync -- --download-reports true --max-download-mib 25
```

The scraper is:

```text
datascrapers/bc/flood/studies/inventory-bc-flood-studies.mjs
```

It writes the ignored local cache:

```text
cache/
  catalogue-metadata.json
  layer-metadata.json
  manifest.json
  studies.geojson
  studies.json
  reports/
```

Current results:

- 166 study records and unique project IDs.
- 155 proponent-hosted report URLs.
- 149 proponent-hosted routes currently respond.
- 27 provincial `REPORT.zip` packages currently respond.
- 163 studies have at least one reachable report route.
- `P000088`, `P000191`, and `P000212` have no currently reachable route.
- All 166 records declare `DataURLAvailable=No`; report-data packages are not
  downloaded, even if a placeholder object happens to respond.
- 24 reports under the 25 MiB cap were downloaded: 21 PDFs and 3 ZIP packages.
- The capped report cache was approximately 250 MiB before the EcoCat mirror.

The 27 reachable provincial report packages total approximately 13.27 GiB. Their
median is about 96 MiB and the largest package is about 7.07 GiB. They are not
suitable for Git and are intentionally separate from the EcoCat attachment mirror.

Downloaded PDF and ZIP signatures are checked. ZIPs pass `unzip -t`; PDFs pass
`pdfinfo`, although `P000018` and `P000230` produce non-fatal structural warnings
from Poppler.

### EcoCat collection mirror

The displayability and per-sub-project resource-link audit is documented in
[`docs/ecocat-display-resource-audit.md`](ecocat-display-resource-audit.md).

Eighty-four older flood studies point to EcoCat collection pages rather than one
report file. Run an inventory without downloading:

```bash
npm run flood-studies:ecocat
```

Mirror the attachments locally:

```bash
npm run flood-studies:ecocat -- \
  --download true \
  --concurrency 8 \
  --max-total-gib 18 \
  --max-file-gib 1 \
  --min-free-gib 8
```

The scraper is:

```text
datascrapers/bc/flood/studies/sync-ecocat-attachments.mjs
```

The ignored cache layout is:

```text
cache/ecocat/
  manifest.json
  P000311/
    page.html
    manifest.json
    documents/
  P000312/
    ...
```

Each per-study manifest retains the study ID, collection URL, attachment label,
source URL, HTTP metadata, local relative path, byte size, and SHA-256. A future
study sub-project should load this manifest as `documents[]` instead of guessing
that a study has one report.

Current corrected mirror results:

- 84 Flood Study Explorer records mapped to 83 unique EcoCat collections.
- 2,853 attachment occurrences.
- 2,830 unique attachment URLs.
- 2,852 successfully downloaded attachment occurrences.
- 15,635,718,883 bytes, or approximately 14.56 GiB.
- 1,608 PDFs.
- 1,002 text/model files.
- 121 ZIP files.
- 112 GIF files, including the one unavailable source.
- 4 JPEGs, 3 DAT files, 1 DWG, 1 XLS, and 1 C39 file.
- No local filename collisions, missing completed files, byte-size mismatches,
  or incomplete `.part` files.

The only unavailable attachment is:

```text
Study: P000333
File: kootkoot____1103221006467_3d21958805e0478da1add4178d8dc656.gif
HTTP status: 404
```

The downloader is resumable. Existing complete files are checked by expected
size and SHA-256. Partial downloads use `.part`, request a byte range on the next
run, and are renamed only after completion. It also enforces:

- a total local-cache byte ceiling;
- a per-file byte ceiling;
- a minimum free-disk-space floor;
- a fixed concurrency limit;
- host/path validation so only EcoCat document URLs are downloaded;
- retained HTTP failures instead of aborting an entire collection.

Do not extract ZIPs automatically. If analysis requires extraction, reject path
traversal, set total expanded-size and per-file limits, and inventory all members.
Do not assume a ZIP contains exactly one PDF.

### Current local disk impact

After the 2026-08-08 EcoCat mirror, the ignored Flood Studies cache occupies
approximately 15 GiB and the local machine has approximately 13 GiB free. This is
a workstation observation, not a repository requirement. Check `df -h` before
refreshing another large source. The cache is reproducible and removable, but it
must not be deleted implicitly by a normal sync or build.

## BC Snow Survey

### Sources and licence records

| Source | Catalogue record |
| --- | --- |
| Snow Survey Administrative Basin Areas | <https://catalogue.data.gov.bc.ca/dataset/9ec01cdb-7085-44fe-b059-9fe5aefb7497> |
| Manual Snow Survey Site Locations | <https://catalogue.data.gov.bc.ca/dataset/9f653102-5627-45a7-bd4c-686e365ee04a> |
| Automated Snow Weather Station Locations | <https://catalogue.data.gov.bc.ca/dataset/ebe546aa-ac34-491c-a828-fdc87fb70610> |
| Current Season Manual Snow Survey Data | <https://catalogue.data.gov.bc.ca/dataset/12472805-6f6d-457b-8db2-5c1f42a00099> |
| Archive Manual Snow Survey Data | <https://catalogue.data.gov.bc.ca/dataset/705df46f-e9d6-4124-bc4a-66f54c07b228> |

All five records above specify the Open Government Licence – British Columbia.

Run:

```bash
npm run snow-survey:sync
```

The command first refreshes the canonical basin boundary from native EPSG:3005,
then queries the two station WFS layers in EPSG:4326 and downloads the current and
archived manual-observation CSVs. It writes:

```text
datascrapers/bc/boundaries/output/BCSnowSurvey/
  comparison.json
  snow_survey_admin_basins.geojson
```

```text
datascrapers/bc/snow-survey/output/
  automated-stations.geojson
  basin-project-index.json
  manifest.json
  manual-archive.csv.gz
  manual-current.csv
  manual-stations.geojson
  station-series-index.json
  stations.geojson
```

The archive is gzip-compressed deterministically. Every output except the manifest
itself has a byte count and SHA-256 recorded in `manifest.json`. Consecutive runs
were compared and produced identical files for identical upstream inputs.

### Current data inventory

- 23 Snow Survey Administrative Basins.
- 390 manual stations: 115 active and 275 inactive.
- 152 automated stations: 133 active and 19 inactive.
- 8 automated stations with camera URLs.
- 461 current-season manual observations from 112 sites.
- 60,604 archived manual observations from 388 station IDs.
- 540 of 542 stations assigned to a snow basin by point-in-polygon.
- The manual and automated Yellowhead stations are outside the published basin
  polygons and remain explicitly unassigned.

Snow Survey basins are snow-program administrative/reporting areas. They must not
replace Freshwater Atlas watershed boundaries. FWA layers may be shown separately
as optional hydrologic context.

The official catalogue lineage says only that the linework was updated on May 15,
2019; it does not identify another boundary family as its source. A reproducible
IoU comparison against 13 existing BC Data Mapper families found no equivalent
family. Two broad drainage features closely match individual basins, while no FWA
major-watershed or watershed-group feature met the 0.98 near-duplicate threshold.
A typical Snow Survey basin contains material portions of six watershed groups,
with a range of one to 38. The authoritative Snow Survey layer is therefore kept
as its own program boundary family rather than reconstructed from FWA.

The manual CSV contains snow depth, snow water equivalent, density, survey date,
survey code, snow-line elevation, and survey period. It does not contain a
percent-normal field. A percent-normal display requires either a separate dated
bulletin source or a documented baseline/climatology calculation.

Automated live observations are not mirrored. Station records contain outbound
Real-Time Water data, report, weekly-report, SWE-report, and camera links where
the official application supplies them.

### Basin sub-project index and routes

`basin-project-index.json` contains one record per basin with:

- stable basin ID, canonical boundary dataset ID, boundary feature ID, and title;
- canonical kebab-case slug;
- compact-slug route aliases;
- WGS84 bounds;
- readiness state;
- manual and automated station counts;
- active station counts;
- current observation and current-site counts;
- archived observation and archived-site counts.

Canonical routes use:

```text
/bcsnowpack/<kebab-case-basin-slug>
```

Example:

```text
/bcsnowpack/upper-columbia
```

The compact form requested during planning remains an alias:

```text
/bcsnowpack/uppercolumbia -> /bcsnowpack/upper-columbia
```

Twenty-one basin records have current manual observations. Stikine has historical
manual data and active automated stations but no current manual observations.
Haida Gwaii currently has no stations or observations and is retained as an
explicit coverage-gap sub-project.

## Repository and deployment rules

- Never force-add `datascrapers/bc/flood/studies/cache/`.
- Do not copy the Flood Studies cache into PGMaps `public/data` without written
  redistribution permission.
- Keep the canonical basin polygons in
  `datascrapers/bc/boundaries/output/BCSnowSurvey/` and the station/observation
  project snapshot in `datascrapers/bc/snow-survey/output/`.
- PGMaps assembles them into generated `public/data/boundaries/BCSnowSurvey/` and
  `public/data/snow-survey/`; do not commit those generated PGMaps copies.
- Commit and push bcdatamapper changes before updating the PGMaps submodule pointer.
- Deployment must initialize the bcdatamapper submodule recursively.

## Validation checklist

Before handing off a refresh:

1. Run `node --check` on each scraper.
2. Run the relevant npm sync command.
3. Verify expected feature and observation counts.
4. Confirm unique project, basin, and station IDs.
5. Verify Snow Survey manifest byte counts and SHA-256 values.
6. Run Snow Survey twice and compare output hashes.
7. Run `npm run snow-survey-basins:compare` and confirm no equivalent family.
8. Confirm the EcoCat cache has no `.part` files after a complete run.
9. Confirm every completed EcoCat manifest path exists and matches its byte size.
10. Review retained HTTP failures rather than deleting them from manifests.
11. Run `git check-ignore` on a Flood Studies cache file before any staging.
