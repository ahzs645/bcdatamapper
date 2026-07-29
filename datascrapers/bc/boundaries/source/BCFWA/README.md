# BC Freshwater Atlas source downloads

Downloaded from authoritative Government of British Columbia services on
2026-07-28 (America/Vancouver). Large raw archives and full-resolution source
GeoJSON are intentionally ignored by Git; this manifest records how to restore
and verify them.

The downloaded files are archived in Google Drive under:

```text
University/Research/Grad/Data/Boundaries/BCFWA/
```

| Local file | Source | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `FWA_BC.zip` | <https://nrs.objectstore.gov.bc.ca/itqlyp/FWA_Public/FWA_BC.zip> | 2,474,934,322 | `3509739dbdb7c740c88b6496c9a2125892746018c92e665e907e5cdde2406deb` |
| `FWA_WATERSHEDS_POLY.zip` | <https://nrs.objectstore.gov.bc.ca/itqlyp/FWA_Public/FWA_WATERSHEDS_POLY.zip> | 1,465,763,346 | `edc721114f8521f55a50061caa8fbb359ef05f51d3f2228a215b631c45bbc699` |
| `FWA_WATERSHED_BOUNDARIES_SP.zip` | <https://nrs.objectstore.gov.bc.ca/itqlyp/FWA_Public/FWA_WATERSHED_BOUNDARIES_SP.zip> | 1,390,384,432 | `ea801b8ca406c2341413c0453ebaae15d3740dabf5685f3eea446759804d92ba` |
| `BC_MAJOR_WATERSHEDS_province_full.geojson` | [BC OpenMaps WFS](https://openmaps.gov.bc.ca/geo/pub/WHSE_BASEMAPPING.BC_MAJOR_WATERSHEDS/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=pub%3AWHSE_BASEMAPPING.BC_MAJOR_WATERSHEDS&outputFormat=json&srsName=EPSG%3A4326&count=1000) | 45,699,343 | `563b07b1e6cdf7704542646f68a9075da0018224a141c941896d68e8f9260728` |

`FWA_BC.zip` contains the provincial File Geodatabase with, among the broader
Freshwater Atlas collection, these polygon layers:

- `FWA_NAMED_WATERSHEDS_POLY`
- `FWA_ASSESSMENT_WATERSHEDS_POLY`
- `FWA_WATERSHED_GROUPS_POLY`

The fundamental watershed polygons and watershed-divider lines are distributed
in their own File Geodatabase archives listed above. The BC major-watershed
layer is a separate legacy product and is therefore downloaded independently.

All three ZIP archives passed `unzip -tq`. Their checksums match the SHA-256
values published in the object-store response metadata. The major-watershed
WFS response contains 224 features in EPSG:4326.

## Rebuild the province-wide assessment web snapshot

From the `bcdatamapper` repository:

```sh
npm run watersheds:assessment-50m
```

The builder first checks `BCFWA_SOURCE_DIR`, then the repository source folder,
then the Google Drive archive location above. It reads `FWA_BC.zip` in place,
extracts all 19,479 assessment watersheds, performs a shared-topology 50 metre
simplification in EPSG:3005, reprojects to EPSG:4326, and writes the
deterministic deployable artifact:

```text
datascrapers/bc/boundaries/output/BCFWA/assessment_watersheds_province_50m.geojson.gz
```

The output retains assessment and watershed-group identifiers needed to reuse
the same geometry for individual assessment and watershed-group views.

For the source snapshot recorded above, the deterministic output contains
19,479 features and is 13,065,464 bytes compressed, with SHA-256:

```text
4e8800fe6d0f49233b6b8802b1c382873cc15d7d7cf5bf3dee2365cd38acf0f8
```
