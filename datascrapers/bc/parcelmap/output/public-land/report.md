# ParcelMap BC initial public-land screening

Reconstruction of the first BCPLM methodology stage using current source data. These are screened public parcel records, not verified available or housing-suitable sites.

| Stage | Parcel records |
|---|---:|
| Original ParcelMap BC polygons | 1,733,553 |
| Five public ownership categories | 321,502 |
| Removed by reserves (additional, in order) | 5,181 |
| Removed by provincial parks (additional, in order) | 8,347 |
| Removed by national parks (additional, in order) | 3,328 |
| Retained after the three exclusions | 304,646 |

## Reproduction choices

- Uses the ParcelMap BC archive last modified Mon, 21 Sep 2026 08:26:12 GMT, not UBC's January 18, 2026 snapshot.
- Selects Federal, Crown Provincial, Crown Agency, Local Government and Untitled Provincial.
- Removes the entire parcel for any intersection with a reserve, provincial park/protected-area or national park polygon. No clipping, buffers or minimum overlap area.
- Uses full-resolution EPSG:3005 geometry throughout; no simplification or coordinate rounding.
- 0 exclusions were boundary-touch-only; 30 invalid parcel geometries were repaired in memory for the predicate calculation. Original output geometries remain unchanged (25 invalid geometries remain in the candidate file).
- Groups by the existing ParcelMap BC REGIONAL_DISTRICT field: 29 named reporting units, including Northern Rockies and Stikine; 0 public parcels have a missing region. The separate legal RD polygons are recorded for source comparison, not used to split or duplicate parcels.
- Conservancies are supplied as a separate provincial layer. Adding them would remove another 1,976 records and retain 302,670. This is reported separately because the published methodology does not identify exact source layer IDs.
- National park geometry is marked Access Only in the catalogue. All downloaded boundary geometry, candidate geometry and per-parcel decisions are kept in the ignored local source cache; this run publishes no map layer.

## Retained records by owner

| Owner category | Records |
|---|---:|
| Crown Agency | 12,651 |
| Crown Provincial | 143,123 |
| Federal | 1,909 |
| Local Government | 96,992 |
| Untitled Provincial | 49,971 |

## Retained records by region

| Region | Records |
|---|---:|
| Capital Regional District | 9,810 |
| Cariboo Regional District | 12,067 |
| Central Coast Regional District | 1,089 |
| Columbia Shuswap Regional District | 9,198 |
| Comox Valley Regional District | 2,218 |
| Cowichan Valley Regional District | 4,788 |
| Fraser Valley Regional District | 7,888 |
| Metro Vancouver Regional District | 56,628 |
| North Coast Regional District | 16,112 |
| Northern Rockies Regional Municipality | 5,605 |
| Peace River Regional District | 25,785 |
| Regional District of Alberni-Clayoquot | 6,862 |
| Regional District of Bulkley-Nechako | 22,240 |
| Regional District of Central Kootenay | 15,951 |
| Regional District of Central Okanagan | 4,254 |
| Regional District of East Kootenay | 10,782 |
| Regional District of Fraser-Fort George | 24,230 |
| Regional District of Kitimat-Stikine | 16,933 |
| Regional District of Kootenay Boundary | 8,964 |
| Regional District of Mount Waddington | 3,600 |
| Regional District of Nanaimo | 4,304 |
| Regional District of North Okanagan | 4,381 |
| Regional District of Okanagan-Similkameen | 6,140 |
| Squamish-Lillooet Regional District | 4,707 |
| Stikine Region | 852 |
| Strathcona Regional District | 3,697 |
| Sunshine Coast Regional District | 2,431 |
| Thompson-Nicola Regional District | 11,613 |
| qathet Regional District | 1,517 |

## What is still needed for later BCPLM stages

This first screen requires neither BC Assessment nor individual strata lot PIDs. Recreating the next stage requires province-wide BC Assessment actual-use, ALR, land-characteristic and land/improvement value data plus a validated PID/folio/roll crosswalk. PGMaps currently has only a Prince George assessment extract. Individual strata records need the Parcel Fabric or shared-geometry cross-reference table; joining attributes one-to-one without checking strata and multiple assessment records would be incorrect.

Additional size/shape, access, amenity, infrastructure, risk and scoring steps have not been applied. The result therefore should not match the published BCPLM final-layer count.

## Sources and outputs

- [UBC methodology](https://hart.ubc.ca/our-publications/bcplm-methodology/)
- `summary.json`: source URLs, snapshot dates, checksums, predicates, counts and limitations.
- `by-region-owner.csv`: complete region/owner summary with counts and summed parcel area.
- `../../source/public-land/public-land-candidates.gpkg`: local full-geometry candidate subset.
- `../../source/public-land/parcel-decisions.csv.gz`: local per-parcel exclusion flags, including conservancy sensitivity.
- [Indian Reserves and Band Names - Administrative Boundaries](https://catalogue.data.gov.bc.ca/dataset/c2ce81af-78c1-467c-b47e-c392cd0a771f): 1,686 source features; Open Government Licence - Canada.
- [BC Parks, Ecological Reserves, and Protected Areas](https://catalogue.data.gov.bc.ca/dataset/1130248f-f1a3-4956-8b2e-38d29d3e4af7): 930 source features; Open Government Licence - British Columbia.
- [National Parks of Canada within British Columbia](https://catalogue.data.gov.bc.ca/dataset/88e61a14-19a0-46ab-bdae-f68401d3d0fb): 102 source features; Access Only.
- [Regional Districts - Legally Defined Administrative Areas of BC](https://catalogue.data.gov.bc.ca/dataset/d1aff64e-dbfe-45a6-af97-582b7f6418b9): 28 source features; Open Government Licence - British Columbia.
- [TANTALIS - Conservancy Areas](https://catalogue.data.gov.bc.ca/dataset/550b3133-2004-468f-ba1f-b95d0e281e78): 169 source features; Open Government Licence - British Columbia.
