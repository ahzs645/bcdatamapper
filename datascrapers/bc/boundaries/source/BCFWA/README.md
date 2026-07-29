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

## Rebuild the province-wide 50 metre web snapshots

From the `bcdatamapper` repository:

```sh
npm run watersheds:50m
```

The unified builder first checks `BCFWA_SOURCE_DIR`, then the repository source
folder, then the Google Drive archive location above. It reads `FWA_BC.zip` in
place and uses pinned Mapshaper `0.6.113` with two topology profiles:

- `assessment` is a non-overlapping partition and uses shared-topology cleaning
  before and after simplification.
- `named` contains intentionally overlapping cumulative drainage polygons and
  uses shared-topology simplification without overlap-removing cleaning.

Both profiles simplify at 50 metres in EPSG:3005, reproject to EPSG:4326,
validate feature IDs, geometry, coordinate reduction, and area change, then
write deterministic gzip snapshots. The partition profile also rejects any
post-repair overlap of 10 m² or more. Build both as above, or one at a time:

```sh
npm run watersheds:assessment-50m
npm run watersheds:named-50m
```

The assessment output is:

```text
datascrapers/bc/boundaries/output/BCFWA/assessment_watersheds_province_50m.geojson.gz
```

The output retains assessment and watershed-group identifiers needed to reuse
the same geometry for individual assessment and watershed-group views.

For the source snapshot recorded above, the deterministic assessment output
contains 19,479 features, expands to 56,019,865 bytes, and is 13,065,697 bytes
compressed, with SHA-256:

```text
3ce375bf28c4e2c346def6a39d5f165e6405d04aab534ce9a2fc62a57533868d
```

The current assessment snapshot has no material overlaps. Its 13 microscopic
post-repair slivers total 4.816466 m²; the largest is 1.772612 m².

## Rebuild the province-wide named-watershed web snapshot

The builder reads all 11,580 features from
`FWA_NAMED_WATERSHEDS_POLY` and writes the deterministic full deployable
artifact:

```text
datascrapers/bc/boundaries/output/BCFWA/named_watersheds_province_50m.geojson.gz
```

It also writes a deterministic manifest and ten exact-stream-order shards:

```text
datascrapers/bc/boundaries/output/BCFWA/named_watersheds_stream_orders_manifest.json
datascrapers/bc/boundaries/output/BCFWA/named_watersheds_stream_order_{1..10}_50m.geojson.gz
```

The application uses these shards so selecting one order does not require
transferring the complete named-watershed snapshot. They can be regenerated
from an existing full snapshot without reopening the source File Geodatabase:

```sh
npm run watersheds:named-order-shards
```

Named watersheds overlap and nest, so the unified builder deliberately omits
the partition-cleaning passes for this profile. It retains the government
name, identifiers, stream order, stream magnitude, area, and stable top-level
feature IDs.

For the source snapshot recorded above, the deterministic output contains
11,580 features, expands to 35,347,601 bytes, and is 10,334,585 bytes
compressed, with SHA-256:

```text
23c98186ab4d362aee0dc3bbc6af43b57dc79a6dfc3d30347bc092a3648b163f
```

| Stream order | Features | Raw bytes | Gzip bytes |
| ---: | ---: | ---: | ---: |
| 1 | 592 | 411,224 | 98,827 |
| 2 | 1,776 | 1,693,311 | 440,915 |
| 3 | 3,189 | 4,651,992 | 1,294,094 |
| 4 | 3,298 | 7,984,554 | 2,321,998 |
| 5 | 1,875 | 8,320,007 | 2,472,387 |
| 6 | 638 | 5,644,393 | 1,695,262 |
| 7 | 160 | 3,329,955 | 1,005,558 |
| 8 | 41 | 1,876,897 | 567,390 |
| 9 | 9 | 981,924 | 298,853 |
| 10 | 2 | 467,148 | 141,615 |
