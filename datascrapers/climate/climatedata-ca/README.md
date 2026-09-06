# ClimateData.ca BC inventory and converters

This directory keeps the reproducible inventory, downloader and conversion tools
for ClimateData.ca. Large source files and derived HDF5 packages stay in the
ignored `cache/` directory; the scripts and product specifications are maintained
in BC Data Mapper.

For the Northern Health report's **BC-wide CanDCS-U6 / SSP585 and ClimateBC snow**
pipeline, see [`bc-climate/README.md`](bc-climate/README.md). It acquires the
upstream sources, preserves all source period/percentile/delta bands, builds
lossless native-grid blocks for Deck.gl, and publishes to R2. No generated data
is checked into Git or copied into PGMaps `public/data`.

The portal is not one homogeneous dataset. For BC it currently breaks into:

1. fixed CanDCS-M6 rasters that share one grid;
2. older CanDCS-U5/U6 projection families;
3. Humidex, SPEI, coastal and seasonal products on other grids;
4. historical gridded/reanalysis sources;
5. station/file collections; and
6. parameterized analyses whose size is not finite until the request is defined.

The structured version of this inventory is [`inventory.json`](inventory.json).
The assessment date is 2026-08-08; estimates should be rechecked when upstream
datasets or station catalogues change.

## Size of the entire BC collection

| Family | BC scope/specification | BC storage |
|---|---|---:|
| Fixed CanDCS-M6 products | 60 downloaded products; 18,012 BC cells; 13 periods; 4 SSPs; p10/p50/p90 | **2.00 GiB measured raw**; 437.21 MiB absolute Float32; 280.62 MiB packed UInt16; 22.19 MiB project subset |
| CanDCS-U5 | ~6 x 10 km NRCANmet target; CMIP5; 3 scenarios; 24 models; p10/p50/p90 | **1-2 GiB** estimate for an equivalent fixed-statistics BC batch; coordinates not yet verified |
| CanDCS-U6 | ~6 x 10 km NRCANmet target; CMIP6; 3 scenarios; 26 models; p10/p50/p90 | **1-2 GiB** estimate for an equivalent fixed-statistics BC batch; coordinates not yet verified |
| Humidex | Separate 0.1 degree grid; 11,928 valid BC cells; 3 thresholds; 3 SSPs; 19-model ensemble; 1950-2100 | **145.79 MiB measured source** for 78 annual/month files; **33.33 MiB** exact UInt16 BC pack |
| SPEI | Separate 1 degree CMIP5 grid; 99 valid BC cells; SPEI-3/SPEI-12; monthly 1950-2100; 3 scenarios; 29 models | **28.54 MiB measured source**; **8.03 MiB** packed BC values |
| Relative sea level + vertical allowance | Separate 0.1 degree coastal family; about 1,896 BC locations; decadal 2020-2100 | **5-30 MiB combined** map-ready estimate |
| Seasonal-to-decadal | CanSIPSv3, about 100 km; temperature and precipitation; 40 members; refreshed monthly | **5-20 MiB** per latest map-ready snapshot; history grows each month |
| CaSR v3 | Historical reanalysis, about 10 km; precipitation and surface variables; CanSIPSv3 climatology source | Unmeasured; a multi-variable sub-daily mirror can be **hundreds of GiB** |
| CanGRD | Historical interpolated observations, about 50 km; temperature, precipitation, wind and humidity | Unmeasured but comparatively small; cadence/period must be selected |
| ERA5-Land | Global historical reanalysis, about 9 km; Humidex target | Unmeasured; a full hourly multi-variable BC mirror is **hundreds of GiB to TiB-scale** |
| NRCANmet | ~6 x 10 km; daily Tmin, Tmax and precipitation, 1950-2012 | About **4.6 GiB uncompressed** for those three BC value cubes before metadata/compression |
| PCIC-Blend | Daily gridded Tmin, Tmax and precipitation; CanDCS-M6 target | Unmeasured; likely **several GiB** for BC depending on the available period |
| AHCCD | 182 BC station packages | **40.4 MiB measured ZIP total** |
| MSC daily observations | 1,762 BC stations; 38,518,200 daily rows | **5.74 GiB CSV estimate**, about **0.6-1.0 GiB gzip** |
| 1981-2010 climate normals | 163 BC stations; 131,050 rows | **29.2 MiB CSV estimate**, about **2-4 MiB gzip** |
| IDF | 155 BC stations | **292.2 MiB measured** for all packages; **212.6 MiB** without derivative quick-start files |
| Future building-design summaries | 106 BC locations; 212 English/French PDFs | **12.5 MiB measured**; about **6 MiB** for English only |

A practical **M6-era project mirror** is approximately **3.1-4.5 GiB**. That range
includes the 2.00 GiB fixed CanDCS-M6 source batch and compressed or compact BC
versions of the map/station/file products assessed so far. Mirroring
equivalent fixed statistics from CanDCS-U5 and U6 would likely add **2-4 GiB**.

A literal mirror of every underlying dataset has no defensible single total until
variables, cadence and periods are selected. It includes daily projection targets
and multi-variable reanalyses such as CaSR v3 and ERA5-Land; a BC-only archive can
therefore grow from tens of GiB into the hundreds-of-GiB or TiB range. Those source
archives should be queried reproducibly rather than committed as project assets.

The station metadata index itself is only about 0.52 MiB and can be shared across
AHCCD, daily observations, normals and IDF where station identifiers align.

## What actually shares data

All 60 fixed downloads use the same 143 x 303 latitude/longitude rectangle and
the same 13 time coordinates. No BC polygon boundary is embedded in these files.
The only duplicated spatial arrays are tiny coordinate axes: 19,860 bytes across
all 60 source files. Sharing coordinates alone therefore does not materially
reduce the 2.00 GiB source batch.

The useful reductions are:

- clip the rectangular files to 18,012 valid BC cells using the existing BC Data
  Mapper regional-district boundary;
- keep absolute values and calculate deltas against the baseline in the app;
- pack values as UInt16 with per-array scale/offset; and
- choose application periods and percentiles instead of shipping every slice.

Humidex, SPEI, coastal products and CanSIPSv3 need independent grid indexes. Their
coordinates can be shared *within* each family, but must not be forced onto the
CanDCS-M6 cell order. The underlying values are rasters/numeric grids; the portal's
interactive vector cells are a map-identification layer, not the climate data
format and not BC administrative boundaries.

CanDCS-U5 and U6 may share NRCANmet coordinates with each other, but they remain
separate until downloaded coordinate hashes prove that. CaSR v3, CanGRD,
ERA5-Land, NRCANmet and PCIC-Blend likewise each need a source-specific adapter;
their catalogue specifications are recorded now, but the current converters do
not pretend those products use the CanDCS-M6 layout.

## Fixed CanDCS-M6 workflow

The fixed product list lives in [`products.json`](products.json). It includes 39
standard annual products, 3 July-to-June snow products and 18 fixed return-period
products. Humidex is deliberately listed as a separate product instead of sending
it through the CanDCS-M6 grid workflow.

From the BC Data Mapper repository:

```bash
npm run climatedata:candcs:download
npm run climatedata:candcs:analyze
npm run climatedata:candcs:pack:u16
npm run climatedata:candcs:app-subset
```

The equivalent direct commands accept `--cache-dir` so an existing assessment can
be reused without copying its multi-gigabyte files into the submodule:

```bash
node datascrapers/climate/climatedata-ca/download-candcs-m6.mjs \
  --cache-dir /path/to/climatedata-cache

uv run --python 3.11 \
  --with-requirements datascrapers/climate/climatedata-ca/requirements.txt \
  python datascrapers/climate/climatedata-ca/analyze-candcs-m6.py \
  --cache-dir /path/to/climatedata-cache

uv run --python 3.11 \
  --with-requirements datascrapers/climate/climatedata-ca/requirements.txt \
  python datascrapers/climate/climatedata-ca/build-candcs-m6-pack.py \
  --mode u16 --cache-dir /path/to/climatedata-cache
```

The analyzer writes `download-analysis.json` and `bc-grid-flat-indices.npy`. The
packer creates a shared-grid HDF5 file containing absolute values only. The app
subset defaults to p50 for source time indices `2,9,12`, corresponding in the
assessed files to 1971-2000, 2041-2070 and 2071-2100. Alternate choices are
available through `--percentile` and `--time-indices`.

## Humidex and SPEI workflow

Humidex and SPEI are downloaded and packed separately because their grids cannot
reuse the CanDCS-M6 cell index:

```bash
npm run climatedata:separate:download
npm run climatedata:separate:analyze
npm run climatedata:separate:pack:u16
```

The maintained request matrix is in
[`separate-products.json`](separate-products.json). It downloads 80 files:

- all three Humidex thresholds (`HXmax30`, `HXmax35`, `HXmax40`);
- annual plus January-December files;
- both 30-year-period and 1950-2100 annual-series forms; and
- complete monthly 1950-2100 SPEI-3 and SPEI-12 files.

The ClimateData.ca endpoint is case-sensitive: `HXmax30` succeeds while the older
assessment spelling `HXMax30` fails. An all-month Humidex request currently returns
HTTP 502, so the downloader requests each month individually and can safely resume.

Measured 2026-08-08 results:

| Family | Source | BC pack | Contents |
|---|---:|---:|---|
| Humidex | 152,870,411 bytes | 34,947,948 bytes | 11,928 cells; 702 absolute arrays; exact integer packing |
| SPEI | 29,923,593 bytes | 8,421,199 bytes | 99 cells; 18 arrays; maximum packing error 0.0000463 SPEI |

Humidex source files also contain 702 delta arrays. The converter omits them because
they can be recomputed from absolute values. Raw files, manifests, grid masks,
analysis and processed packs remain under ignored `cache/separate-grids/`.

## Project candidates

These packages can support several projects without copying BC boundaries into
each project:

- **BC Climate Projections** — CanDCS-M6 variables, a period/scenario comparator,
  percentile controls and client-computed change from baseline.
- **Heat and Humidex** — its own 0.1 degree grid, threshold selector and historical
  versus future periods.
- **Drought Climate Indicators** — SPEI-3/SPEI-12 on the coarse 1 degree grid;
  it should be distinguished from observed provincial drought levels.
- **Coastal Change** — relative sea-level projection and vertical allowance at
  coastal locations, with scenarios and uncertainty percentiles.
- **Seasonal Outlook** — the latest CanSIPSv3 snapshot, carrying an explicit issue
  date because the source refreshes monthly.
- **Climate Stations** — a shared station registry with observation, normals,
  AHCCD and IDF tabs loaded on demand.
- **Building Climate Design** — location search and links to source summaries;
  PDFs need not be rendered as map geometry.

Parameterized indicators can also become projects, but only after their recipe is
versioned: indicator, threshold, season/months, baseline, periods, SSPs,
percentiles and output units. Where the result uses CanDCS-M6, the converter can
reuse `bc-grid-flat-indices.npy`; only the new value arrays need to be stored.

## Sources

- [ClimateData.ca data catalogue](https://climatedata.ca/about/our-data/)
- [CanDCS-M6 introduction](https://climatedata.ca/resource/intro-to-candcs-m6/)
- [Seasonal-to-decadal forecasts](https://climatedata.ca/seasonal-to-decadal/)
- [PAVICS data access](https://climatedata.ca/news/accessing-climate-data-using-pavics/)
- Fixed raster download endpoint: `https://data.climatedata.ca/download`

Before publishing any source snapshot, confirm the current upstream licence and
attribution. The ignored cache is for assessment and reproducible local builds;
it is not automatically a redistributable archive.
