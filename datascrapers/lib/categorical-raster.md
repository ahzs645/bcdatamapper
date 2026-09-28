# Categorical raster to polygons

`categorical_raster.py` is a reusable converter for **one integer class band**
with an affine grid transform and CRS. Class values are carried unchanged as
`feature.properties.value`. The converter has no CCISS-specific codes, colours,
thresholds, or labels. RGB images and continuous bands are rejected; classify
continuous values explicitly upstream if class polygons are the desired result.

```sh
uv run --with rasterio==1.5.1 python datascrapers/lib/categorical_raster.py \
  --input classes.tif --output output/classes-polygons
```

The output directory must not exist. Use a fresh staging directory for rebuilds,
compare manifests/checksums, then replace the dataset's generated output through
its release workflow. Inputs are never modified. `--block-size` defaults to 256
native cells (range 16–1024); `--max-classes` defaults to 256. Codes must fit exact
JavaScript integers. Files supported by Rasterio can be used, including GeoTIFF
and COG; the source file is processed locally, not fetched by this utility.

## Data contract

`manifest.json` has format `categorical-raster-polygons-v1`. It records source
filename, SHA256, bytes, CRS, affine transform, dimensions, NoData, class counts,
validation results and every block's geographic bounds, path, feature count,
compressed bytes and SHA256. Each `tiles/<row>-<column>.geojson.gz` is a WGS84
FeatureCollection. Feature IDs combine source block and polygon index. They are
deterministic within an identical build, not stable identifiers between vintages.

Blocks are **native raster windows**, not XYZ zoom tiles. Consumers intersect
their bounds with the viewport and fetch only the required files. Gzip has a
zero timestamp and JSON has deterministic key order. There is no geometry
simplification or coordinate rounding. Joining adjacent same-class pixels can
produce holes; NoData stays absent. Class zero remains a valid value unless
the source mask marks it missing. Diagonal cells use four-neighbour connectivity.

Polygonization happens on integer pixel edges. Every block is rasterized back
and compared to all input pixels, and each class's polygon area in pixel units
must equal its cell count. Coordinates are then transformed using the original
global grid. For non-WGS84 sources each pixel-edge vertex is retained before
reprojection, so shared segments use the same transformed endpoints. Published
WGS84 polygons are transformed back and rasterized for a second full cell check.
Curved projected edges are approximated by those per-cell segments; this does
not assert zero continuous-area error after reprojection. Dateline-crossing
geometry and coordinates beyond Web Mercator's latitude range are rejected.

This is a grid partition, with no independent polygon smoothing. Topology
simplification from `mapshaper-topology.mjs` is intentionally not applied because
moving a class edge would break exact cell fidelity. A later generalization pass
would need a separate output contract and validation.

## Validation and browser reuse

```sh
PYTHONDONTWRITEBYTECODE=1 uv run --with rasterio==1.5.1 python -m unittest \
  discover -s datascrapers/lib -p test_categorical_raster.py -v
```

Fixtures cover holes, NoData, diagonal contact, adjacent blocks, class zero,
negative codes, deterministic output, a rotated BC Albers grid, and rejected
RGB/continuous/excess-class inputs. Published polygons are checked for cell
coverage, missing cells and overlaps after reprojection.

PGMaps consumes this format through `MapCategoricalRaster` in
`src/components/ui/map-categorical-raster.tsx`. It takes `manifestUrl`,
`colorForValue`, `onPick`, `onStatus`, optional `opacity` and `attribution`.
It uses the shared deck.gl overlay lifecycle and six concurrent block requests.
Visible blocks load first, nearest the view centre first, with a 25% viewport
margin prefetched afterward. Viewport updates run during movement (throttled to 120 ms);
new requests wait for movement to end, avoiding work for transient zoom extents.
completed blocks draw progressively, batched to animation frames. All wanted
blocks stay cached plus 32 recently used offscreen blocks. Still-needed requests
survive camera changes; obsolete requests are cancelled. Partial failures retain
available geometry with an explicit incomplete-coverage status and retry when
the next camera movement ends. Picking and colour
both use the polygon's stored value. A full province view can still require
all blocks; polygonization often makes more data than the compressed raster.

## Optional display overviews

`categorical_overviews.py` builds a `categorical-raster-pyramid-v1` index with
zoom levels pointing to the existing block-manifest format. It checks the full
manifest's source checksum, then samples the same integer raster at overview
cell centres. Masks and class codes are sampled together; zero can remain valid.
The original extent is preserved even when dimensions are not divisible by the
factor. Each overview runs the converter's full geometry round-trip checks.

Overviews are **generalized display grids**: small patches can disappear and
boundaries can shift within the coarser grid. They are not exact native-cell
lookups and must not be used for area calculations. No polygon is independently
smoothed; shared boundaries remain edges of the overview grid. Full-detail
polygons are reused unchanged. The raster files and manifests record the exact
affine transforms and sampled class counts.

```sh
uv run --with rasterio==1.5.1 python datascrapers/lib/categorical_overviews.py \
  --input classes.tif --full-manifest output/polygons/manifest.json \
  --output output/overviews --level 8:0 --level 4:6 --level 2:7
```

Each `--level` is `factor:minZoom`; full detail starts one zoom above the last
overview's minimum. Levels are dataset-specific display choices. CCISS uses
8× below zoom 6, 4× at 6–7, 2× at 7–8 and full detail at 8+. A 0.2 zoom deadband
avoids repeated swaps near a boundary. `MapCategoricalRaster` accepts either
format, loads level manifests lazily, retains the previous level until all
visible replacement blocks are ready, and keeps a bounded cache for each level.
Obsolete block requests are aborted. Overview picks carry `overview: true`,
which callers must label as generalized. Other numeric consumers can keep using
the unchanged full-detail manifest.

## Explicit image reconstruction (separate from numeric conversion)

`palette_classes.py` provides an opt-in classifier for four-band RGBA arrays and
an explicit class/RGB palette. It preserves transparent NoData and assigns a
separate uncertain code when alpha, colour distance, or separation from the
runner-up colour fails the supplied thresholds. Its output is inferred display
classes, never recovered measurements. The bounded example is
`../bc/cciss/trace-public-tiles.py`; keep its provenance and uncertainty labels
with the output. Check the classifier with `test_palette_classes.py`.

For data known or assumed to have regular geographic cells,
`grid_class_reconstruction.py` can assign one inferred label per cell from the
interior image pixels. The caller must supply the grid origin and angular step;
the utility does not claim to discover them. It preserves unresolved cells,
requires adequate classified coverage and voting agreement, and excludes partial
border cells. The CCISS `--grid` example adds an image-agreement gate and records
the assumptions. Tests are in `test_grid_class_reconstruction.py`.
