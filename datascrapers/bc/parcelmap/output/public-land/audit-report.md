# Public parcel comparison with UBC BCPLM

Snapshot audit: September 22, 2026. The reference is the published `BCPLM_Apr13/FeatureServer/214` polygon layer (data edit timestamp August 26, 2026). Our parcel archive was published September 21, 2026; the written UBC method refers to January 2026 inputs. This audit does not change our candidate set.

## Findings

| Finding | Evidence | Interpretation and next action |
|---|---|---|
| Different processing stage (high impact, confirmed) | Our initial screen retains 304,646 records. The published layer has 52,384 rows. Our set still includes 31,455 parcels below 100 m², 80,655 above 2 ha, and 85,060 records without a PID. | Keep the initial public-land universe. Add later exclusions as separate, auditable stages; a missing PID does not make land nonpublic. |
| Different record grain (high impact, confirmed) | Published rows represent 50,100 distinct PIDs. 2,173 PIDs repeat; 2,103 repeated PIDs have identical normalized geometry. There are 2,284 extra rows beyond distinct PID and 1,915 extra rows even beyond PID + jurisdiction + roll. | Compare physical parcel footprints separately from assessment records. Do not call every repeated PID an error or a strata unit. Only 277 repeated PIDs have multiple jurisdiction/roll pairs in this extract; the remaining multiplicity needs source lineage. |
| Most matching footprints agree, but some do not (medium impact, confirmed) | Of 52,240 published rows with a current PID match, 49,109 (94.01%) have intersection/union area of at least 0.99. 1,612 have that ratio below 0.5. | Identifier matching alone was insufficient. Use geometry concordance as a separate validation field; investigate large differences before transferring assessment attributes. |
| Exclusion discrepancies are not all tiny slivers (high impact, confirmed discrepancy; cause unresolved) | Of 457 published records removed by our spatial screen, 54 overlap current exclusions by under 1 m², 153 by under 1% of their current footprint, and 215 by at least 50%. Using the published geometry itself, 216 overlap by at least 50%; 200 of those also closely match the current footprint (intersection/union ≥0.99). | Do not relax intersections just to match the site. Compare historical masks and exact UBC selection logic. Current masks and different snapshots cannot establish whether a January selection was wrong. |
| Published region labels conflict with geography (high impact, strong spatial evidence) | 6,972 published region labels disagree with the legal RD polygon containing an interior point. Current parcel attribution agrees with the spatial check for 6,890 of these. 161 points have no match in the legal RD layer, which omits Northern Rockies. | Retain independently sourced region attribution and record discrepancies. An interior-point test is not a full area-based assignment, so boundary-spanning parcels still need review. Large cross-province discrepancies are not explained by that limitation. |
| Live map and written area rule disagree (high impact, confirmed; reason unresolved) | The method says remove parcels above 2 ha, but 3,527 published records exceed 2 ha using both their area field and projected polygon geometry. 3,091 exceed 2.1 ha and 257 exceed 10 ha. | The discrepancy is not merely rounding near 2 ha. Keep separate “published-method” and “live-map comparison” results; confirm whether the live layer contains intentional exceptions or the method is outdated before choosing final rules. |
| Ownership snapshots disagree (medium impact, confirmed; transfer history unverified) | 83 published public records have a PID whose current owner category is Private. 74 of these have footprint overlap ≥0.99. Another 10 change between public owner categories. | Flag for review and preserve both source dates. WHEN_UPDATED is not an ownership-change date and cannot prove a transfer. |
| Missing PIDs are not fixed by the current strata fabric (medium impact, confirmed current-service result) | None of 144 missing PIDs appeared in the current Parcel Fabric query; a known PID positive control succeeded. All 144 footprints intersect current parcels; 16 have a best current match with intersection/union ≥0.95 under another identifier. | Changed parcel representation or identifiers are plausible for some cases; this is not proof of historical subdivision. Do not replace IDs automatically using overlap. We cannot infer January strata membership from a current query. |
| Conservancies remain an explicit policy choice (medium impact, confirmed) | Adding the separate conservancy mask would remove another 1,976 of our candidates; 54 published records intersect that mask. | A stricter public-land screen and a literal live-layer reconstruction can differ. Record this as a named optional exclusion rather than silently expanding the parks mask. |

## Regional examples

| Published label | Current ParcelMap BC attribution | Matching published records |
|---|---|---:|
| Northern Rockies | North Coast | 3,415 |
| Central Kootenay | Columbia Shuswap | 1,924 |
| Thompson-Nicola | Cariboo | 552 |
| Nanaimo | North Okanagan | 385 |

These are same-PID attribution comparisons; the independent interior-point check is reported separately above. For a directly inspectable example, published OBJECTID **24290**, PID **014-785-439**, is labelled “Northern Rockies”. Its polygon falls in **North Coast**; the published address is Prince Rupert and its footprint nearly exactly matches current ParcelMap BC. Another example is OBJECTID **13277**, PID **016-718-178**, labelled “Central Kootenay” but spatially in Columbia Shuswap.

## Controlled diagnostic reductions

These are comparisons only, not changes to the public-land output:

| Diagnostic subset of our retained screen | Records |
|---|---:|
| Initial retained public parcels | 304,646 |
| With a usable PID | 219,586 |
| Between 100 m² and 2 ha, using current source area | 192,536 |
| Both a PID and within that size range | 152,909 |

Even the combined diagnostic set is much larger than 50,100 published distinct PIDs. BC Assessment actual-use, ALR, land-characteristic, access and other exclusions remain necessary to recreate later stages. The exact narrow/long parcel cutoff is not supplied in the prose, so it has not been guessed.

## Recommended next implementation

1. Preserve the source public-land universe and explicit exclusion flags; report parcel counts by stable source polygon ID, with distinct PIDs as a separate measure.
2. Use current parcel/legal-boundary geography for regional reporting, while retaining the published label as a comparison attribute.
3. Implement later size and assessment exclusions as named optional stages with reason codes. Do not change the mask tolerance or overwrite ownership to force agreement.
4. Obtain the January ParcelMap/exclusion snapshots or UBC's actual processing code to resolve the 457 exclusion discrepancies and the live layer's exceptions to its prose rules.
5. Acquire appropriate province-wide assessment data and validate PID/folio/roll join multiplicity before using assessed values or derived land uses.

## Evidence and reproducibility

- [UBC methodology](https://hart.ubc.ca/our-publications/bcplm-methodology/)
- [Published BCPLM layer](https://services2.arcgis.com/NlsizNmbMFiinWw4/arcgis/rest/services/BCPLM_Apr13/FeatureServer/214)
- [ParcelMap BC polygons](https://catalogue.data.gov.bc.ca/dataset/2f4117d9-41fc-44db-87d4-dbdb77f14086)
- [ParcelMap BC fabric](https://catalogue.data.gov.bc.ca/dataset/4cf233c2-f020-4f7a-9b87-1923252fbc24)
- [Legal regional district boundaries](https://catalogue.data.gov.bc.ca/dataset/d1aff64e-dbfe-45a6-af97-582b7f6418b9)
- Aggregate results: `audit-summary.json`, `audit-followups.json`.
- Inspectable companion notebook: `../../public-land-audit.ipynb`.
- Local per-record CSVs: `../../source/public-land/audit-exceptions.csv`, `audit-geometry-comparison.csv`.
- Local footprint follow-ups: `../../source/public-land/audit-missing-pid-footprints.json`.

Full geometries and raw reference records remain in the ignored local source cache. Three audit tests check PID normalization, overlapping-mask area accounting, and regional aliases. The published pull checked all row IDs and an unchanged service edit timestamp across pagination. Audit geometry validity repairs are recorded in the JSON and used only for measurement.
