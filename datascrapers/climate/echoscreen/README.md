# EchoScreen consultant climate vectors

`build.py` extracts the four analytical rasters and embedded QGIS colour ramps
from the verified Northern Health consultant GeoPackage (82,436,096 bytes).
The original source is [on Drive](https://drive.google.com/file/d/1Qz7bXQbK6pjzBPF1D0uhlqQgf36LpS_l/view).
Source SHA256 is pinned in the builder; keep the large archive outside Git.

```sh
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python build.py /path/to/NH_climate_projection_maps.gpkg
```

Deployable `output/` contains deterministic gzip GeoJSON polygon blocks and
manifests. PGMaps syncs this directory to `public/data/echoscreen-climate`.
These are native-grid vector blocks, as in CCISS, rather than MVT/PMTiles.
Every original Float32 value and missing cell survives conversion. Coordinates
are neither rounded nor simplified. Adjacent polygons retain shared grid edges;
equal-value neighboring cells may merge. Each build rasterizes the published
polygons and verifies all original values and missing cells.

The heat variable is annual days **above 29°C**, P50, SSP585, for 1971–2000 and
2071–2100. It is not the live portal's differently valued >30°C layer.
Precipitation layers contain future minus past seasonal totals in **mm**, as
labelled in the embedded consultant layouts. Summer and winter retain their
original continuous ramp, including alpha and clipping behaviour. Heat retains
its original continuous 0–64 ramp. No display bins or generalized overviews are
used. Source rasters are 249 × 97 with 12,779 valid cells apiece.

Only the analytical climate surfaces are extracted. Existing PGMaps hospital,
boundary, watershed and portal river context remains app-owned context. This
does not duplicate every feature or print layout from the consultant archive.
