# BC EnviroScreen Reconstruction release package

This directory contains the stable configuration and schemas used to turn the
normalized 89-LHA reconstruction into a small, calculation-ready public
release. Large source archives and working release files remain under the
ignored `output/bc-enviro-screen` tree; the compact reviewed development
fallback is the deliberate exception described below.

The public label is **BC EnviroScreen Reconstruction**. It is a hybrid research
reconstruction, not an official Province of British Columbia or paper-author
product.

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
