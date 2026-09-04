# BC EnviroScreen Reconstruction release package

This directory contains the stable configuration and schemas used to turn the
normalized 89-LHA reconstruction into a small, calculation-ready public
release. Large source archives and working release files remain under the
ignored `output/bc-enviro-screen` tree; the compact reviewed development
fallback is the deliberate exception described below.

The public label is **BC EnviroScreen Reconstruction**. It is a hybrid research
reconstruction, not an official Province of British Columbia or paper-author
product.

Refresh the current official NRCan source-family candidate for the paper's
combined industrial-sites indicator before running validation when those
sources need to be updated:

```sh
npm run environmental-burden:bc-enviro-screen:nrcan-industrial-lha
```

The builder combines forestry mills, producing metal/nonmetal/coal mines,
smelters/refineries, and oil/gas fields. Its output remains labelled a proxy
because the exact September 2020 source binaries have not been recovered.

The socioeconomic validation builders also retain two explicit sensitivity
families without silently changing the released score: the documented
December 2011–September 2012 four-quarter EI window, and renter-housing
candidates with 50/75/90% minimum retained-denominator coverage. The 2014 EI
candidate and unmasked renter result remain selected because the historical
window lowers rank agreement and the coverage masks reduce complete LHA
coverage. EMS candidate output now fails fast if an LHA/candidate pair is
duplicated.

Build after the validation and score stages:

```sh
npm run environmental-burden:bc-enviro-screen:release
```

Validate a release and preview its R2 object plan:

```sh
npm run environmental-burden:bc-enviro-screen:publish
```

Add `-- --upload` only after reviewing the plan and configuring an Object Read
& Write `r2` AWS CLI profile scoped to the `maps` bucket.

`release-snapshot/` is the compact, checked-in development fallback consumed
by PGMaps when the public R2 pointer is unavailable. It contains only the
calculation-ready JSON release (89 LHAs × 21 indicators), never the heavy source
archives. Refresh it with the deterministic release builder and review the
release ID before committing it.

```sh
npm run environmental-burden:bc-enviro-screen:snapshot
```
