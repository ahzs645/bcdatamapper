# Versioned BC early development data

Local, reproducible EDI source capture and review products for PGMaps. The UBC aggregate workbook, dashboard values, and dashboard display polygons remain in ignored `cache/`. This package does not publish to R2 or copy restricted products into `public/`.

## Run

Requires Node 22+ (tested with Node 26), Python 3.9+, curl, and [uv](https://docs.astral.sh/uv/). Only the boundary crosswalk needs a Python package: `uv` runs it with the pinned `requirements-crosswalk.txt` (Shapely). Every other Python step is standard library only. Run from this repository:

```sh
node datascrapers/bc/early-learning/run-local.mjs --capture 2026-09-22 --workers 4
```

Or from PGMaps:

```sh
npm run early-learning:sync:local -- --capture 2026-09-22 --workers 4
```

The full regional capture is substantial. Requests are sequential within each client, with at most four clients. Completed area files are reused; rerunning resumes missing areas. Use a new capture identifier for a new source release. `--refresh` on the dashboard collector explicitly replaces raw area captures under the same capture identifier, but previously normalized products remain immutable.

The workbook must already exist at `../early-learning-boundaries/cache/EDI_data_library_wave_2_to_8.xlsx`. On a fresh checkout, run `npm run early-learning-boundaries:sync` first to download it and assemble the neighbouring source inventory. This package hashes the actual workbook; it does not assume the file name proves its contents.

Individual steps:

```sh
node datascrapers/bc/early-learning/prepare-tls.mjs
export NODE_EXTRA_CA_CERTS="$PWD/datascrapers/bc/early-learning/cache/tls/issuer.pem"
python3 datascrapers/bc/early-learning/capture-current-boundaries.py --capture 2026-09-22
node datascrapers/bc/early-learning/capture-dashboard.mjs --capture 2026-09-22 --workers 4
node datascrapers/bc/early-learning/capture-wave-boundaries.mjs --capture 2026-09-22
uv run --python 3.11 --with-requirements datascrapers/bc/early-learning/requirements-crosswalk.txt python datascrapers/bc/early-learning/crosswalk.py --capture 2026-09-22
python3 datascrapers/bc/early-learning/normalize.py --capture 2026-09-22
python3 datascrapers/bc/early-learning/validate.py
```

The dashboard collector accepts `--limit`, `--families GEOSD,NH,...`, and `--regions CHSA_2210,...` for focused work. The product manifest records incomplete inventory coverage. Do not run overlapping collectors that write the same areas or boundary files. The main collector captures nine boundary families, including nine all-area summaries; the regional search inventory is not a promise that every area has Wave 9. After the wave-map capture, a second regional pass adds valid map IDs omitted from search and resolves their names from the verified breadcrumb.

The publisher currently omits an intermediate TLS certificate. `prepare-tls.mjs` downloads the issuer certificate, verifies a pinned SHA-256, verifies its signature against Node's bundled trusted root, and checks CA status and validity dates. The extra CA file applies only to the child processes. HTTPS verification stays enabled. A changed pin fails closed and requires investigation; never use `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Products and provenance

- `cache/captures/<capture>/source.html` and `regions.json`: source inventory.
- `regions/<region>.json`: area, selected detail wave, original chart series, counts, standardized scores, publisher change descriptions, demographics, participation, and source errors. These are public aggregates, not individual child records.
- `boundaries/<family>.geojson`: map geometry observed during the regional capture.
- `wave-boundaries/<family>-<wave>.geojson`: separately verified geometry displayed by the publisher for each wave. The collector checks both the breadcrumb and the wave in map tooltips. CHSA capture starts at Wave 7.
- `crosswalk.json` (in the capture folder): each dashboard area code compared with the current official polygon of the same family. See **Boundary crosswalk** below.
- `cache/current-boundaries/<capture>/`: current official WFS responses and source URL, retrieval timestamp, SHA-256, feature count, and property mapping. These never overwrite the shared BCMoH snapshots.
- `cache/products/blobs/<sha256>.json.gz`: deterministic compressed JSON; SHA-256 identifies **uncompressed canonical JSON**.
- `cache/products/releases/<sha256>.json`: immutable manifests. The release hash excludes only the manifest's own `releaseId` field.
- `cache/products/latest.json`: current local manifest; references immutable blobs for both the historical workbook and the dashboard capture.
- `cache/products/validation.json`: local validation and geometry-join coverage report.

The existing HELP library polygons, legacy MCFD polygons, and older local administrative snapshots are preserved as reference editions. The four current health layers are tied to their exact WFS classes in archived DataBC catalogue metadata, which identifies the 2022 boundary configuration. Other effective editions remain unknown; download dates are not relabelled as effective dates.

## Data rules

Workbook normalization retains 56 measurements × seven waves for each area, including Province. Numeric zero remains zero. Dashboard coverage distinguishes uncollected historical outcome bars, publisher-disabled waves, periods before CHSA reporting, and values not reported in the chart. Empty workbook cells become `not_reported_or_suppressed`; the source cannot distinguish those cases. Non-numeric suppression tokens are retained in `raw`. Counts, percentages, and standardized scores have distinct units. The all-CHSA multiple-vulnerability chart emits 50 zeros before CHSA reporting begins at Wave 7; these are preserved as `sourceValue: 0` but displayed as `outside_reporting_period`. Reported zeros within the reporting period remain numeric zero.

The Province workbook's percentage column says “0 Scale” beside a “1 Scale” count. The percentage remains `pct_multiple_0`, with the inconsistency disclosed in the manifest. No correction is inferred.

Dashboard trends remain a separate source release even when they cover the same waves as the workbook. Outcomes/demographics use each area's `detailWave`, normally 9. Map-only areas use their latest wave found in verified publisher geometry; `detailWaveSelection` records this choice, which does not establish availability of later detail charts. When the publisher disables Wave 9, the collector reads its disabled-case declarations as data and retries the latest selectable wave. It never executes publisher-supplied JavaScript. Subscale identities and response area/wave identities are checked; stale chart values are not silently accepted. Communication has no detailed subscales.

A map join requires a polygon the dashboard drew for the selected wave, or a current official polygon that the crosswalk finds covers the same area. Workbook values use the dashboard's polygons by area code; see **Workbook map join**. Old New Westminster `2210` is never copied onto `2211`–`2214`. Regions missing from the publisher's search inventory or map remain explicit coverage gaps.

Current MCFD organization has 7 SDAs and 44 LSAs, but a matching current vector source is still unverified. The older 13-SDA geometry is labelled legacy. The existing 45-LSA DataBC archive is kept separately from the dashboard's 47-area geometry.

## PGMaps review

Start PGMaps development mode and open `/dev/early-learning`. The page supports source release, wave, geography, boundary edition, measure, area search, mapped values where compatible, trend tables, published counts, and publisher notes. `?release=<manifest-sha256>` opens an immutable local snapshot.

Vite's `/__dev_early_learning/` middleware serves only `latest.json`, hash-named release manifests, and hash-named compressed blobs from this cache. It has no production/preview handler. The production build contains no EDI cache files. Source publication restrictions are recorded in `../early-learning-boundaries/source-manifest.json`; R2 publication requires resolving that existing policy first.

## Validation

```sh
python3 -m unittest discover -s datascrapers/bc/early-learning -p 'test_*.py'
node --test datascrapers/bc/early-learning/shiny.test.mjs
python3 datascrapers/bc/early-learning/validate.py
```

The product validator checks every referenced hash, unique area/wave/measure keys, numeric ranges and units, missing statuses, valid closed polygon rings, coordinate order/BC extent, region IDs, and feature counts. It reports unmatched boundary/result IDs. PGMaps adds focused join/formatting tests under `src/pages/early-learning/data.test.ts` and browser checks for historical/current switching.

## Aggregate calculations and shared geometry

`calculations.py` annotates published percentages with a separate arithmetic check: 100 × published numerator / sum of three complete outcome counts for that scale, area, wave, and release. Exactly 1–5 vulnerable-scale percentages use the overall outcome denominator. Suppressed/missing counts are never inferred; neither demographics nor the ambiguous Province 0-scale label is included. The check also compares the sum of exactly 1–5 scale counts with the overall vulnerable count. It never sums the overlapping individual-domain vulnerability counts. Published values are retained even if a check differs. `calculationAudit` summarizes coverage and discrepancies per source/family. The validator recomputes the checks from their inputs.

This reproduces aggregate arithmetic, not child-level scoring, standardized subscales, or meaningful-change classifications. An unavailable calculation is distinct from an unavailable published value.

Dashboard wave maps share one polygon per region ID per family (`dashboard_library()`). No captured ID is drawn differently between waves — the waves differ only in which IDs they display — so each wave reference stores its `regionIds` and points to the family's library. The normalizer fails if a future capture redraws an ID. This cut dashboard geometry from 23.7 MiB to 7.1 MiB compressed.

`boundary_geometry()` hashes exact coordinates and region IDs in stable feature order. Names and source/wave metadata live in each manifest boundary reference, so identical maps share an asset without losing their provenance. Different coordinates or region membership create separate assets. `regionNames` supplies labels at read time; older immutable releases still carry labels in their blobs. `boundaryStorage` reports snapshot and distinct-asset counts. Geometry reuse does not change `joinPolicy` or permit allocating older aggregate results to changed boundaries. Existing local sources are read directly during normalization and are never redownloaded by it. Raw source archives and earlier immutable releases are retained.

## Boundary crosswalk

`crosswalk.py` compares each dashboard polygon with the current official polygon that has the same code (CHSA, school district, HA, HSDA and LHA; there is no verified current MCFD or HELP edition). Both layers are first clipped to the land they both cover, because the dashboard draws some coastal areas out over water and the official school-district layer extends over water. Overlap is then measured as intersection over union in an equal-area projection.

| Status | Meaning | Map behaviour |
| --- | --- | --- |
| `same_area` | IoU ≥ 0.95 | The code's EDI value may be shown on the current polygon |
| `changed` | The code exists today but covers a different area | Value stays on the dashboard polygon |
| `not_in_reference` | The code no longer exists (`CHSA_2210`) | Value stays on the dashboard polygon |
| `referenceOnly` | A current code with no EDI polygon (`CHSA_2211`–`2214`) | No value |

Changed and missing areas list the overlapping codes and shares for context. They are never used to allocate values. For the 2026-09-22 capture:

| Family | Same area | Changed | Code gone | Current only |
| --- | ---: | ---: | ---: | ---: |
| CHSA | 192 | 21 | 1 | 18 |
| School districts | 30 | 29 | 0 | 0 |
| Health authorities | 5 | 0 | 0 | 0 |
| HSDAs | 16 | 0 | 0 | 0 |
| LHAs | 89 | 0 | 0 | 0 |

A matching code is not evidence of the same area. Burnaby `CHSA_2222` exists in both editions with no overlap: the old area is now `2223` and `2224`. The dashboard's school districts differ from the official layer well beyond coastline drawing, so about half stay on the dashboard polygons.

The crosswalk records the hashes of both geometries it compared. `normalize.py` refuses a crosswalk whose hashes do not match the current inputs, and embeds it in the release otherwise. The viewer uses it only on a reference edition with exactly those coordinates.

## Workbook map join

The workbook ships no geometry. `workbook_map_join()` draws a workbook value on the dashboard polygon with the same code and wave, but only for families where every value published by both releases agrees: 88,370 overlapping values across nine families, with no disagreements after allowing for one-decimal display rounding. It also checks that every numeric workbook value has a polygon drawn for its wave; none is missing. UBC does not publish this pairing, so the manifest records it as `inferred_by_region_id` with its evidence, and the viewer labels it. A family with any disagreement stays table-only. The validator recomputes the evidence from the blobs.
