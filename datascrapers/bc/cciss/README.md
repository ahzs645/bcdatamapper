# CCISS historical raster comparison

This snapshot supports PGMaps' historical lodgepole pine (`Pl`), edatope `C4`
comparison and reference BGC numeric lookup. The original downloads were obtained
from the public CCISS Spatial page's **Download Province** control on 2026-09-27.
Original downloaded TIFFs are retained unmodified in `output/`; the COG is a
lossless prepared copy. See `output/provenance.json` for checksums and selections.

The suitability download is `FeasibilityRaw_1961_1990_C4_Pl.tif` in Shiny's
download handler. The public mapped tile product is named
`NewFeas_1961_1990_ref_C4_Pl`, and its values differ in some locations. This
snapshot does not claim those products are equivalent or provide the separate
site-series model inputs used by CCISS reports.

The generic converter is `../../lib/categorical_raster.py`:

```sh
uv run --with rasterio==1.5.1 python datascrapers/lib/categorical_raster.py \
  --input datascrapers/bc/cciss/output/historical-download-1961-1990-C4-Pl.tif \
  --output /tmp/cciss-polygons-new
```

After validation, the generated directory belongs at
`output/historical-Pl-C4-polygons`. It contains 308 native grid blocks,
79,887 polygons, and 6,900,717 compressed tile bytes for this snapshot. All
35,646,021 cells, including 11,028,673 valid cells, pass the class/NoData round trip.
Class counts: 10 = 4,283,171; 20 = 5,334,373; 30 = 1,411,129.

PGMaps copies this output to ignored `public/data/cciss` via
`npm run data:sync-from-bcdatamapper`. Commit and push the scraper snapshot first
before updating the parent submodule pointer for deployment. Never add the
generated app copy to the parent repository.

## Public tile tracing pilot (2026-09-27)

`trace-public-tiles.py` reconstructs **display classes**, not measured CCISS
values. It archives a fixed 3×3 zoom-12 tile mosaic (x 628–630, y 1310–1312)
near Fraser Lake, uses the Shiny legend's four RGB colours, marks ambiguous
pixels as 99, and preserves transparent pixels as NoData. Euclidean sRGB
thresholds (distance <=60, runner-up margin >=20, alpha >=250) are heuristics,
not calibrated confidence. The generic classifier is `../../lib/palette_classes.py`.

```sh
uv run --with rasterio==1.5.1 python datascrapers/bc/cciss/trace-public-tiles.py \
  --longitude=-124.666920 --latitude=54.209275 \
  --archive datascrapers/bc/cciss/sources/public-tile-trace \
  --output /tmp/cciss-public-trace-new
```

The accepted snapshot is in `output/public-tile-trace`: provenance, explicitly
named `inferred-display-classes.tif`, and verified polygons. The nine original
WebPs live in `sources/public-tile-trace`. Source URLs and checksums are recorded.
All 589,824 pixels round-trip through the polygons unchanged. There are 494,769
inferred High pixels, 92,592 Moderate and 2,463 uncertain (0.4176%). The latter
render purple. 102 polygons occupy 94,908 compressed bytes. No boundary smoothing
is applied; shared raster edges remain shared. All 12 output files were byte
identical on a repeat build from the archived source images. These checks prove
fidelity to the inferred raster, not to an unavailable numeric source.

### Matching source search

The live TileJSON lists `/sapho/kdaust/FFEC/suitability_rasters/NewFeas_1961_1990_ref_C4_Pl.tif`,
a server filesystem path, not a public download URL. The tile-server index links
only to this layer's TileJSON and preview. A direct HTTPS request to
`/data/NewFeas_1961_1990_ref_C4_Pl.tif` returned 404. The official Environmental
Suitability Ratings catalogue (1810fdca-8762-4d6a-8886-4e8cefbdb640) lists a ratings
CSV and documents, not this raster. The Biogeoclimatic Projections catalogue
links back to the Shiny app. Its public source download handler selects
`FeasibilityRaw_1961_1990_C4_Pl.tif`, already in this snapshot. No matching public
GeoTIFF download was found; the file has not been acquired or converted.

To complete that path, request **the original single-band class raster used to
build `NewFeas_1961_1990_ref_C4_Pl.mbtiles`**, together with the CRS, NoData, class
legend and version/date. Inspect the returned TIFF's bands: the filename alone
does not establish that it contains numeric classes rather than rendered RGB.
Do not relabel the traced TIFF or the existing `FeasibilityRaw` download as this
missing source. No contact request has been sent.

## Grid-based reconstruction (default Tile trace view)

Run the same command with `--grid` and a fresh output path. This requires archived
`tilejson.json` alongside the WebPs. `grid_class_reconstruction.py` accepts the
assumed geographic grid origin and step separately from the display classes.
This pilot uses the layer bounds' west/north origin (-139.000139, 60.000139) and
an assumed 10-arc-second (1/360 degree) step, supported by the repeated boundaries
in the captured image. It is a geographic grid, not a square-metre grid.

Vote using classified pixel centres in each cell's central 60% width/height.
Require at least four classified pixels, >=80% classified coverage and >=80%
agreement for a winner. Conflicting/sparse cells remain uncertain; fully missing
interiors stay NoData. Publish only complete captured cells, with no extrapolation
at the edge of the nine-tile mosaic. Reject a build if fewer than 99.5% of eligible
classified image pixels agree with the inferred cell raster. This gate includes
pixels outside the voting interiors, but it is not independent source-data truth.

`output/public-grid-trace` has 5,170 cells (4,337 inferred High, 833 Moderate).
Every cell had unanimous classified interior votes with at least 32 pixels;
no cell is uncertain in this sample. All 575,925 eligible classified image pixels
within its extent agree on rasterization back to the image grid. Compression-
ambiguous image pixels and cropped partial border cells are excluded from that
comparison. The 5,170-cell native/published geometry round trip passes too.

Adjacent equal classes merge into 3 polygons / 997 gzip bytes. The older pixel
trace remains available via **Image pixels**; **Grid cells** is the default.
Grid unit tests cover edge noise, class conflicts, sparse evidence, NoData and
partial-cell clipping. This remains inferred display data; using the grid does
not recover model-member values or validate per-site calculations.

## Entire published layer

The **Grid cells** default now uses `output/province-grid-trace`, covering the
full layer extent. The nine-tile outputs above are retained as development
reference samples. See [province-trace.md](province-trace.md) for the complete
resumable download/build pipeline, source archive and validation results.

## Legacy browser analysis package

`prepare-legacy-analysis.py --source /path/to/CCISS_ShinyApp-main` prepares
`output/legacy-analysis`: 32 unchanged numeric BGC TIFFs, 10 regional gzip JSON
summaries and ecological lookup tables, about 12.9 MB. The complete older source
data are about 489 MB and are not copied wholesale. Source paths/checksums and
licence are retained; no current prediction arrays are claimed.

**Codebook discrepancy:** the bundled levels.bgc.csv does not match the TIFFs.
Conversion requires unique count-signature matches across all 37 BC BGC rasters
and their labelled summary rows. All 324 present codes match uniquely; 315 labels
change. The method and warning are recorded in the manifest. Browser point
results remain provisional pending an authoritative matching codebook. Regional
species ratios use explicitly labelled tables and do not depend on this repair.

The PGMaps implementation and full current-data requirements are documented in
`docs/cciss-client-analysis.md` in the parent repository.


## Public current reference inputs

`prepare-current-inputs.py --download` acquires pinned public ccissr reference
objects and the BC catalogue CSVs, producing 27 gzip JSON tables (about 603 KB).
Separate package/catalogue groups preserve their versions. The manifest flags
the S1 schema mismatch with the downloaded Shiny calculator; these are not yet
a version-matched current calculator bundle. See parent `docs/cciss-current-inputs.md`.
`export-current-pilot.sql` is a read-only owner handoff for missing prediction/site
data; `validate-current-pilot.py` checks a returned pilot. No database was contacted.
