# EcoCat display and sub-project resource audit

This audit answers two product questions for the 84 Flood Study Explorer records
that point to legacy EcoCat pages:

1. What can PGMaps display meaningfully?
2. Which official resources can each flood-study sub-project link to?

Status date: 2026-08-08. The source is Access Only. Counts describe the local,
ignored research mirror and must not be interpreted as permission to publish the
mirrored documents.

## Executive summary

- **Every EcoCat-backed sub-project has useful source material.** All 84 study
  records have an official EcoCat collection link, at least one PDF, and at least
  one item classified as a floodplain map. The 84 records resolve to 83 unique
  EcoCat collections because `P000322` and `P000371` share report ID `1842`.
- **The best immediate product is a curated resource library.** Display the study
  title, author, publication date, audience, source description, and grouped
  resource counts, then send users to the official EcoCat collection. Direct PDF,
  image, text, and download links are technically available, but publishing or
  inline-embedding them needs a terms decision.
- **There is no ready-to-map GIS package in this archive.** The ZIPs contain PDF
  drawings and legacy hydraulic-model files, not Shapefile, GeoJSON, GeoPackage,
  KML, or GeoTIFF layers. Many coordinate files explicitly use assumed local
  coordinates. They cannot be placed on the map without per-study validation and
  georeferencing.
- **A second phase could create useful derived views.** HEC/HEC-2 cross-section
  data could support profile charts, and map sheets could be georeferenced after
  source terms, coordinate control, and quality requirements are resolved.

## Dataset and grain

The product grain is one Flood Study Explorer `Project_ID`. One project may have
many EcoCat attachments. The current local audit contains:

| Measure | Count |
| --- | ---: |
| Flood-study records pointing to EcoCat | 84 |
| Unique EcoCat collection pages/report IDs | 83 |
| Attachment references | 2,853 |
| Unique attachment URLs | 2,830 |
| Available attachment references | 2,852 |
| Unavailable attachment references | 1 |

The duplicated collection is:

| EcoCat report | Flood Study Explorer records |
| --- | --- |
| `1842` | `P000322`, `P000371` |

Those two child projects should remain distinct if their Flood Study Explorer
records are distinct, but their resource collection should be resolved once and
shared rather than presented as two independent archives.

## What can be displayed or linked now

### Source-defined document groups

The EcoCat pages already organize attachments into useful source categories:

| EcoCat category | Resources | Studies covered | Recommended UI |
| --- | ---: | ---: | --- |
| Report Documents | 234 | 68 | Reports and summaries |
| Digital Map Files | 1,575 | 84 | Maps and technical drawings |
| Data Files | 1,043 | 77 | Advanced/source-data downloads |
| Map Plotfiles | 1 | 1 | Advanced/source-data download |

Sixteen study records have no attachment in the source's `Report Documents`
section, but all still have an official collection, PDF resources, floodplain
maps, and source descriptions. The UI must not label a map sheet or model file as
the study report merely to fill that gap.

### Product-oriented content tags

Tags may overlap because, for example, a PDF can be both a floodplain map and a
technical drawing.

| Content type | Resources | Studies covered | Immediate use |
| --- | ---: | ---: | --- |
| Floodplain maps | 684 | 84 | Featured `View maps` group |
| Reports or summaries | 247 | 70 | Featured `Reports` group |
| Technical drawings or profiles | 1,867 | 82 | Collapsed technical-resources group |
| Model or source data | 1,190 | 78 | Download-only advanced group |
| Gauging-station references | 99 | 44 | Related evidence/resources |
| Observed events or photos | 23 | 16 | Related evidence/resources |
| Indexes, legends, or format guides | 194 | 83 | Place next to the resources they explain |

Floodplain-map formats are 566 PDFs, 111 GIFs, 4 JPEGs, and 3 ZIP files. Report
or summary formats are 229 PDFs, 13 text files, 4 ZIP files, and 1 spreadsheet.

### Browser presentation

The 2,852 available attachment references break down into:

| Presentation option | Resources | Product treatment |
| --- | ---: | --- |
| Official PDF link | 1,608 | Open at source; inline preview only after terms approval |
| Official text link | 1,002 | Open/download at source; do not treat raw model text as prose |
| Official image link | 115 | Open at source; thumbnailing requires terms approval |
| Other official download | 127 | Label file type and size before opening |
| Unavailable | 1 | Disabled resource with an availability note |

All 1,608 top-level PDFs pass `pdfinfo` and contain 5,811 pages in total. A
first-three-page extraction found meaningful text in 1,346 PDFs; 262 had little
or no extractable text and are probably scans, map sheets, or image-heavy
drawings. This is good enough for a PDF viewer or outbound link, but not enough to
promise full-text search without OCR and document-level QA.

The one unavailable item remains the GIF recorded for `P000333`.

## ZIP and legacy-data findings

All 121 ZIP attachments pass `unzip -t`. They contain 1,944 members, including:

- 1,038 PDFs;
- 241 text files;
- 110 DAT files;
- HEC/HEC-2, OUT, GRD, SMP, CAL, profile, and related model files;
- a small number of DWG and spreadsheet files.

No ZIP member uses a common ready-to-map GIS format such as `.shp`, `.geojson`,
`.gpkg`, `.kml`, `.tif`, or `.tiff`. Two `.prj` members occur without an
accompanying Shapefile set and appear in legacy model packages, so they are not
evidence of GIS-ready geometry.

The collection has 305 HEC-labeled attachment references across 76 studies and
446 coordinate-labeled references across 75 studies. These are potentially
valuable research inputs, but sampled coordinate files warn that they use
assumed local coordinates. Safe derived products would be:

1. cross-section elevation/profile charts that do not imply map position;
2. model/file inventories and downloadable-source links;
3. georeferenced cross-sections or map sheets only after a study-specific CRS,
   datum, control-point, and accuracy review.

## Recommended flood-study child UI

Each `/bcfloodstudies/:studySlug` child should have a `Resources` section with:

1. an always-visible **View official EcoCat collection** action;
2. source title, author, publication date, audience, description, report ID,
   report type, and subject;
3. source-defined groups for reports, digital maps, data, and plotfiles;
4. resource rows containing label, source description, media type, byte size,
   availability, and an external-source indicator;
5. featured shortcuts for floodplain maps and reports;
6. a collapsed technical/source-data area for HEC files, coordinate files, ZIPs,
   CAD, and spreadsheets;
7. a clear statement that historical map sheets are not current hazard mapping
   and the Flood Study Explorer index geometry is not an inundation polygon.

Use the official collection page as the default outbound route. It preserves the
source context, disclaimer, related-file grouping, and report metadata. Direct
attachment links are useful secondary actions, but should not be the only way to
reach the source.

The EcoCat host returns the expected PDF and text media types and supports byte
ranges, so browser PDF viewing is technically possible. It does not provide a
cross-origin API for PGMaps to parse in the browser. Build-time copying is also
not authorized by the Access Only record. Production choices are therefore:

- link to the official collection page now;
- obtain written permission and publish a small derived resource index; or
- use an approved server-side integration that reads current source metadata at
  request time and preserves required notices.

## Data-quality and licensing guardrails

- **High:** the flood-study dataset is Access Only. Do not deploy the local HTML,
  PDFs, images, ZIPs, or generated audit JSON without written permission.
- **Medium:** `P000322` and `P000371` share the same official collection. Deduplicate
  fetching and downloads while preserving both study relationships.
- **Medium:** 16 studies lack an explicit report document. Present available map
  and data resources honestly; do not invent a primary report.
- **Medium:** legacy coordinates may be local, assumed, or poorly documented.
  Never place them on the map based only on numeric ranges.
- **Low:** one `P000333` GIF is unavailable. Preserve the broken-resource status
  so a future source refresh can detect recovery.

## Reproducible audit

Run:

```bash
npm run flood-studies:ecocat:audit
```

The script reads the ignored EcoCat manifests and cached source HTML, restores
the source document groups and collection metadata, applies product-oriented
tags, and writes:

```text
datascrapers/bc/flood/studies/cache/ecocat/display-resource-audit.json
```

That output contains all 84 study records, official collection URLs, metadata,
resource categories, tags, media types, sizes, access status, and source URLs. It
is an ignored research artifact, not a deployable PGMaps payload.
