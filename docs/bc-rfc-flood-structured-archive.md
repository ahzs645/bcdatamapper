# BC River Forecast Centre flood archive and structured data

This note records the current PGMaps/bcdatamapper flood data consolidation work.

## Current intent

PGMaps should not publish the full raw BC River Forecast Centre advisory archive as loose files.
The bcdatamapper submodule should own the flood source archive and generated structured outputs.
PGMaps should consume only small app-facing JSON outputs during build/sync.
The repo should not keep loose generated flood text files; PDF text is derived from the compressed raw archive when the structured builder runs.

Recommended split:

- Keep raw PDF/HTML/HTM advisory source files as a single compressed archive in bcdatamapper for provenance.
- Publish structured JSON separately for PGMaps and downstream map/timeline work.
- Do not deploy raw PDFs, HTML files, or generated text files to the live PGMaps site unless a feature explicitly needs them.

## Current flood paths

```text
datascrapers/bc/flood/
  flood-advisory-seeds.txt
  sync-bc-rfc-flood-advisories.mjs
  pilot-clean-legacy-html-advisories.mjs
  pilot-extract-structured-advisories.mjs
  build-structured-advisories-pilot.mjs
  archive/
    raw.tar.gz
  output/
    advisories.json
    discovery.json
    manifest.json
tmp/
  flood-raw/
  flood-structured-full.json
  flood-structured-limit20.json
```

## Raw archive package

The raw archive package is:

```text
datascrapers/bc/flood/archive/raw.tar.gz
```

It contains the historical `raw/` directory contents:

```text
datascrapers/bc/flood/archive/raw/
```

The loose `archive/raw/` and `archive/text/` directories are not kept in the working tree. When a rebuild needs raw HTML/PDF files, extract the tarball into:

```text
tmp/flood-raw/raw/
```

Current contents:

- `736` raw advisory files
- `495` PDF files
- `234` `.htm` files
- `7` `.html` files
- One top-level `raw/` directory entry in the tarball

Current sizes:

- loose raw folder before compression: about `88M`
- compressed tarball: about `80M`

Build command from the bcdatamapper root:

```bash
npm run flood:raw:archive
```

Equivalent direct command:

```bash
tar -czf datascrapers/bc/flood/archive/raw.tar.gz -C datascrapers/bc/flood/archive raw
```

Extract command from the bcdatamapper root:

```bash
npm run flood:raw:extract
```

Equivalent direct command:

```bash
rm -rf tmp/flood-raw
mkdir -p tmp/flood-raw
tar -xzf datascrapers/bc/flood/archive/raw.tar.gz -C tmp/flood-raw
```

Inspect command:

```bash
tar -tzf datascrapers/bc/flood/archive/raw.tar.gz | sed -n '1,40p'
```

## Structured advisory pilot

The current structured builder is:

```text
datascrapers/bc/flood/build-structured-advisories-pilot.mjs
```

It reads:

- `datascrapers/bc/flood/output/advisories.json`
- `tmp/flood-raw/raw/*` after `npm run flood:raw:extract`
- HTML-backed advisories directly from extracted raw `.htm`/`.html` files
- PDF-backed advisories by running `pdftotext` against extracted raw PDFs when no legacy public text file is present

It writes only where `--out` points. As a pilot safety guard, it refuses to write into:

- `datascrapers/bc/flood/output/`
- `datascrapers/bc/flood/archive/`

Run from the bcdatamapper root:

```bash
npm run flood:structured:pilot
```

Equivalent direct command:

```bash
npm run flood:raw:extract
node datascrapers/bc/flood/build-structured-advisories-pilot.mjs --out tmp/flood-structured-full.json
```

Current full-run coverage:

- processed: `707`
- failures: `0`
- cleaned HTML records: `232`
- PDF text records: `475`
- advisory blocks: `703`
- matched boundaries: `694`
- cleaned named areas: `655`
- Wayback timestamps: `254`
- hydrometric observations: `407`
- normalized hydrometric V2 observations: `257`
- weather mentions: `677`
- normalized weather quantities: `398`
- forecast timing/events: `676`
- records still missing an issued timestamp after fallback parsing: `1`

## Structured fields currently extracted

Each structured record includes:

- `source`: original id, URL, paths, content type, issuer, archive metadata.
- `document`: title, cleaned title, issued timestamp/text, parse flags, filename action, lifecycle summary.
- `parser`: source kind (`pdf_text` or `cleaned_html`), template, line counts.
- `advisoryBlocks`: level, status, active/inactive state, areas, rivers, communities, evidence lines.
- `advisoryBlocks[].matchedBoundaries`: filtered document boundary matches with match confidence and evidence.
- `geography`: cleaned named areas, regions, rivers, communities, matched boundaries, boundary sources.
- `hydrometricObservations`: first-pass flow/gauge/return-period snippets.
- `hydrometricObservationsV2`: normalized flow/gauge/level-change values, units, ranges, trends, station ids, return periods.
- `weatherAndForecast`: broad precipitation/snowmelt/temperature/forecast/model mention snippets.
- `weatherQuantities`: normalized rainfall/precipitation/snowmelt/freezing-level/temperature quantities with units and evidence.
- `forecastTiming` and `forecastEvents`: timing snippets and forecast event hints.
- `sections`: detected advisory sections where headings are present.
- `quality`: confidence, flags, and extraction notes.

## Live PGMaps impact

The current PGMaps flood map tab uses live ArcGIS/River Forecast Centre services.
It does not currently fetch `/data/flood/raw/*`, `/data/flood/text/*`, or the structured flood archive.

That means removing raw flood files from PGMaps public data should not affect the current live flood layer, as long as no new feature references those raw paths.

The structured flood output is intended for future features such as:

- advisory timeline
- event history
- region/watershed advisory lookup
- document provenance/debug links
- hydrometric/weather narrative search

## Recommended next step

Promote the pilot into a production builder after schema review:

```text
datascrapers/bc/flood/build-structured-advisories.mjs
datascrapers/bc/flood/output/structured-advisories.json
```

Then PGMaps should sync only:

```text
output/advisories.json
output/manifest.json
output/structured-advisories.json
```

The raw archive should remain available as:

```text
datascrapers/bc/flood/archive/raw.tar.gz
```

It can also be copied to external storage or release artifacts, but loose raw or text files should not be published as app data.
