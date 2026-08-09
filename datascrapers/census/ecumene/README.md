# Population ecumene boundaries

This directory maintains two intentionally separate boundary products:

1. The official generalized 2021 Statistics Canada population ecumene for
   province- and national-scale thematic maps.
2. An experimental fine-scale residential ecumene rebuilt from the same 2018
   GHSL functional built-up product used by the Universite Laval heat-wave
   vulnerability project.

Neither geometry replaces the canonical 2021 dissemination-area boundaries.
Both are alternate display geometries that can receive DA-level attributes by
joining `DAUID`.

## Official Statistics Canada ecumene

Run:

```bash
uv run datascrapers/census/ecumene/fetch-statcan-bc-ecumene.py
```

The script fetches the `ECUMENE=1` polygons from the official Statistics
Canada REST service, clips them to the official BC province boundary, rounds
coordinates deterministically, and writes:

- `datascrapers/census/output/ecumene/statcan-bc-population-ecumene-2021.geojson.gz`
- `datascrapers/census/output/ecumene/statcan-bc-population-ecumene-2021.manifest.json`

Source: Statistics Canada, *2021 Population Ecumene Boundary Files*, released
2022-02-09 under the Open Government Licence - Canada.

The source service contains one overlapping ECUID pair (`1185` and `52`),
covering approximately 4.47 km2. The snapshot deliberately preserves the
official ECUID features. Consumers should dissolve/union the features when
using the layer as a binary mask.

## Laval-style GHSL reproduction pilot

The Laval scientific report describes this processing chain:

1. Select the residential and non-residential classes from
   `GHS_BUILT_C_FUN_E2018_GLOBE_R2022A` at 10 m resolution.
2. Select intersecting cells from a 10,000 m2 hexagonal tessellation.
3. Extract tessellation vertices and create a TIN.
4. Remove TIN triangles whose perimeter exceeds 350 m.
5. Remove dissemination blocks with zero population.
6. Smooth the result and split it by 2021 DA boundaries.

The pilot implements those published steps with open-source libraries. It
automatically downloads and checksum-verifies the 16 MB GHSL `R3_C10` tile
covering Prince George; the 8.8 GB global archive is not required.

First fetch the full-resolution official DB, DA, and CMA/CA inputs used by the
pilot. The files are deterministic local source caches and remain ignored by
Git:

```bash
uv run datascrapers/census/ecumene/fetch-prince-george-census-inputs.py
```

The CMA/CA geometry is not another display boundary. Its lower-left extent in
Statistics Canada Lambert is used only to reproduce the origin of the
10,000 m2 hexagonal tessellation.

```bash
uv run datascrapers/census/ecumene/rebuild-prince-george-ecumene.py \
  --laval-shapefile /path/to/VlnExpVagueChaleur.shp
```

Outputs:

- `datascrapers/census/output/ecumene/prince-george-city-ghsl-ecumene-pilot.geojson.gz`
- `datascrapers/census/output/ecumene/prince-george-city-ghsl-ecumene-pilot.evaluation.json`

The released Laval geometry is used only as an optional evaluation baseline.
It is not an input to the rebuilt boundary.

### Current fidelity result

For the 135 Prince George city DAs, the maintained experimental build reaches
98.99% intersection over union against Laval's released geometry, with 99.33%
precision and 99.65% recall. All 135 `DAUID` features are valid and unique,
and the output has no polygon-area overlaps.

The largest fidelity gains came from reconstructing two details omitted from
the prose methodology:

| Variant | Intersection over union |
| --- | ---: |
| Mollweide working grid and raster-label shortcut | 85.61% |
| Exact GHSL polygon-to-hex intersection in Mollweide | 86.11% |
| Exact intersection in BC Albers (EPSG:3005) | 89.87% |
| Statistics Canada Lambert (EPSG:3347), arbitrary global grid origin | 91.90% |
| EPSG:3347 with the official CMA lower-left grid origin, before smoothing | 98.36% |
| Same origin with the maintained smoothing approximation | 98.99% |

This is strong evidence that the original workflow created each city's grid in
the national NAD83 Statistics Canada Lambert projection and anchored it to the
CMA/CA extent. It remains an inference, not a claim made in the report.

The remaining difference is concentrated along smoothed edges. Laval's model
diagram names ArcGIS **Smooth Polygon**, but the report does not publish
whether it used PAEK or Bezier interpolation or provide a PAEK tolerance. The
open rebuild therefore labels its two-pass Chaikin treatment as an
approximation and retains `status: experimental`. The evaluation JSON records
all source paths, inferred parameters, output checksums, and validation counts.
