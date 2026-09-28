# Full-layer CCISS grid reconstruction

This pipeline reconstructs the **display classes** of the public
`NewFeas_1961_1990_ref_C4_Pl` layer across its entire published bounding box. It
uses every zoom-12 tile in that extent, not a mask inferred from a lower zoom.
Other species, periods and edatopes remain the public imagery choices in PGMaps;
they are not covered by this particular inferred snapshot.

## Rebuild

Run from the repository containing these scripts. Use an external/ignored cache
for the working download and a new output directory. PGMaps' example paths are:

```sh
python3 vendor/bcdatamapper/datascrapers/bc/cciss/download-province-tiles.py \
  --archive tmp/cciss-province-source \
  --metadata vendor/bcdatamapper/datascrapers/bc/cciss/sources/public-tile-trace/tilejson.json

uv run --with rasterio==1.5.1 python \
  vendor/bcdatamapper/datascrapers/bc/cciss/build-province-trace.py \
  --archive tmp/cciss-province-source \
  --output tmp/cciss-province-grid-new \
  --source-store vendor/bcdatamapper/datascrapers/bc/cciss/sources/province-tiles
```

The downloader uses eight concurrent requests with bounded timeouts/retries,
checks the complete WebP container, and promotes successful `.part` files
atomically. Rerunning reuses complete files. HTTP 204 responses are recorded as
empty source tiles; HTTP failures stop the run instead of silently creating holes.
`--wait-for-download` on the builder optionally lets it process completed rows
while the downloader fills later ones. Conversion starts over on rerun, reusing
the downloaded source cache. Never reuse that cache across source vintages without
an explicit refresh; resuming is intended for one capture.

## Grid and classification

- EPSG:4326 origin comes from the archived layer bounds; spacing is the explicit
  10-arc-second assumption validated in the regional checks.
- Use only pixel centres in each cell's central 60% width and height.
- Accumulate votes across **all source tile seams** before choosing a cell class.
- Require at least four classified pixels, 80% classified coverage of the
  expected interior samples, and 80% agreement among classified samples.
- Fully missing interiors stay NoData. Insufficient or conflicting observations
  remain class 99 (purple), not interpolated or filled from neighbouring cells.
- Codes 10/20/30/40 are inferred High/Moderate/Low/Unsuitable display classes.
  They are not CCISS model-member data or a substitute for the numeric download.

The output raster is polygonized by the generic categorical converter. It keeps
original grid coordinates and shared edges, without independent smoothing.
Each native block and its published WGS84 geometry are rasterized back and checked
against the inferred raster. Per-class polygon areas equal cell counts. These
checks establish conversion fidelity, not correctness against an unavailable
original numeric raster.

## Ownership and archives

Publish the accepted output under `output/province-grid-trace` and assemble
`public/data/cciss` through PGMaps' normal data-sync command. Do not commit the
ignored generated PGMaps copies. Commit/push the scraper snapshot before updating
the parent repository's submodule pointer.

`sources/province-tiles/objects/<sha256>.webp` deduplicates identical source images.
Its deterministic `index.json.gz` maps every XYZ tile to its content hash, size and
HTTP status. The archive retains the layer's TileJSON as well. The working cache
can be reconstructed from that index and the objects without new downloads.
`output/province-grid-trace/provenance.json` contains coverage, class counts,
archive checksum, payload sizes and validation results.

The original nine-tile pixel trace remains available as a labelled comparison
sample; **Grid cells** is the complete-layer option.

## Accepted full-layer capture

The completed build consumed all 65,550 source tiles (25,691,210 image bytes;
34,271 empty/transparent responses). Identical images deduplicate to 20,086 source
objects. The inferred raster is 8,981 × 4,209 = 37,801,029 cells, of which
17,172,893 carry a display class. Counts are:

| Code | Inferred class | Cells |
|---|---|---:|
| 0 | NoData | 20,628,136 |
| 10 | High | 4,287,661 |
| 20 | Moderate | 5,598,097 |
| 30 | Low | 1,737,388 |
| 40 | Unsuitable | 5,549,747 |
| 99 | Uncertain | 0 |

All 706,484,884 accepted classified interior votes agreed with their winning
class in this capture. This is a display-vote statistic, not accuracy against
original numeric/model data. Separate regional checks in northern BC, southeast
BC, Vancouver Island and Prince George showed full classified-image agreement;
the full raster matched all 20,868 cells in those regional reconstructions.
`regional-validation.json` retains those results and their grid assumptions.

All 37,801,029 cells pass polygon/native and published-geometry round trips.
27,306 polygons are partitioned into 321 native blocks, totalling 6,356,713 gzip
bytes (excluding the manifest). The browser fetches visible blocks and a nearby
margin; the source-image archive is not downloaded by the browser.

## Zoom-dependent display

Build the optional overviews from the accepted inferred TIFF, without fetching
the public tiles again (run from PGMaps):

```sh
uv run --with rasterio==1.5.1 python \
  vendor/bcdatamapper/datascrapers/lib/categorical_overviews.py \
  --input vendor/bcdatamapper/datascrapers/bc/cciss/output/province-grid-trace/inferred-display-classes.tif \
  --full-manifest vendor/bcdatamapper/datascrapers/bc/cciss/output/province-grid-trace/polygons/manifest.json \
  --output vendor/bcdatamapper/datascrapers/bc/cciss/output/province-grid-trace/overviews \
  --level 8:0 --level 4:6 --level 2:7
npm run data:sync-from-bcdatamapper
```

Choose a new output directory for rebuilding. Full-layer compressed geometry
sizes, excluding indexes:

| Zoom (nominal) | Grid sampling | Blocks | Gzip bytes |
|---|---|---:|---:|
| Below 6 | 1:8 overview | 9 | 747,455 |
| 6–7 | 1:4 overview | 25 | 1,850,362 |
| 7–8 | 1:2 overview | 91 | 4,098,136 |
| 8+ | Full cells | 321 | 6,356,713 |

Only viewport blocks and a margin load at each level. The distant overview is
88.24% smaller than full geometry, with 97.2% fewer block requests for the whole
extent. These are payload reductions, not measured network-speed promises.
All overview polygons pass their own sampled-grid round trips. Generalization
can omit small patches; the UI labels overview picks and returns to unchanged
full cells when zoomed in. These remain inferred display classes at every level.
