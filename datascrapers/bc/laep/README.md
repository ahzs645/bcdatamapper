# BC Stats Local Area Economic Profiles

The 2025 LAEP release is the source for an initial regional-district forestry
dependency and economic diversity story in PGMaps. It is a historical model,
with 2010, 2015 and 2020 reference years, not a current economic dashboard.

```sh
python3 datascrapers/bc/laep/sync-laep.py --refresh
python3 datascrapers/bc/laep/test_laep.py
```

Omit `--refresh` to rebuild offline. Python's standard library is sufficient.
`source/` contains deterministic gzip copies of all 12 official CSVs and a
manifest with original URLs, SHA-256 hashes and licence information. Only
published indicator tables feed the outputs. Source inputs are never executed.

## Outputs and interpretation

- `output/regional-districts.json`: 29 unique census-division IDs, joined to
  PGMaps' existing 2021 `bc-da-simplified/parents/cd.geojson`. Geometry is reused
  unchanged, so this workflow does not simplify or alter any boundaries.
- `output/area-indicators.json.gz`: 399 records (103 EDAs, 29 RDs and BC, for
  three periods), retaining numeric values and separate missing/suppression
  statuses. Local-area indicators are tabular only, pending geography review.
- `output/audit.json`: counts, input duplication diagnostic and output hashes.

Income-dependency numbers are percentages of modelled **basic/external income**,
not fractions, job shares or percentages of all household income. Location
quotients are ratios of employment shares to the BC benchmark. Employment is by
residence; jobs and LQs refer to the census year following the model reference
year. Monetary values are nominal. The diversity index measures the spread of
basic income sources. The forest vulnerability index is relative, not a
probability or a linear measure of loss; compare within geography and period.
RD and EDA scores must not be ranked together. Trend differences are percentage
points calculated from published rounded shares. Display bins are descriptive,
not official risk classes. `F`, `x`, `-` and blanks never become numeric zero.

## Source audit, 27 September 2026

The seven published output CSVs were checked against cached values in the
official 2025 Excel toolkit, joining rows by their keys rather than position.
Their values agree at the CSVs' displayed precision. This checks publication
consistency; it does not independently reproduce BC Stats' model.

Two issues are intentionally unresolved:

1. The cleaned `laep-source-data-2010.csv` and `laep-source-data-2015.csv` repeat
   all 425 numeric row arrays despite changing the period/industry labels.
   Neither file is used to derive the published indicators here. Original
   census IVT files are needed to resolve the upstream duplication before any
   model reconstruction.
2. The 2020 area concordance lists `5949830` as Moricetown 1 in Cassiar Corridor.
   The 2021 Statistics Canada boundary uses `5949817` for Moricetown 1. The
   concordance's Cassiar population totals 1,889, while its published descriptive
   total is 1,636, a difference of exactly the disputed 253-person row. The
   toolkit repeats the conflict. Do not silently substitute the ID or reassign
   this community. The concordance also spells Fort St. James - Stuart as
   “Staurt”; stable area IDs and explicit reviewed aliases are needed.

NEDD's older local supply share series has no direct same-named table in the
2025 release. Its relationship to the newer demand-source model remains
unverified. Do not relabel demand-source shares as local supply shares.

## Sources and licence

- [Official dataset](https://catalogue.data.gov.bc.ca/dataset/local-area-economic-profiles-dataset)
- [Technical report](https://www2.gov.bc.ca/assets/gov/data/bc-stats/laep-products/local_area_economic_profiles_2025.pdf), especially pp. 51 and 60–69.
- [2025 toolkit](https://www2.gov.bc.ca/assets/gov/data/bc-stats/laep-products/local_area_economic_profiles_2025_toolkit.xlsx)
- [Original custom census data](https://catalogue.data.gov.bc.ca/dataset/084f7cab-0f47-40a7-86bf-3e112856cad6)
- [Statistics Canada 2021 reserve/CSD concordance](https://www12.statcan.gc.ca/census-recensement/2021/dp-pd/ipp-ppa/about-apropos/tab-band-bande.cfm?LANG=E)

Contains information licensed under the Open Government Licence – British
Columbia. Boundary sources retain their Statistics Canada attribution. The
2025 catalogue's licence applies to these datasets; NEDD's separate 2023 toolkit
permission and CityViz presentation are not the source of this import.
