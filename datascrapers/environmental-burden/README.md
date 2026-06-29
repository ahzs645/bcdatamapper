# Environmental Burden Inventory

This scraper records source metadata for candidate EnviroScreen burden layers:
NPRI, Federal Contaminated Sites Inventory, BC waste discharge authorizations,
groundwater wells and observation wells, EMS/EnMoDS water quality, Water Quality
Objectives, and historical mapped floodplains.

It is an inventory/probe step, not the final bulk ingest. The point is to keep
the polling plan and source sizes current before adding heavier download and
normalization pipelines.

```bash
npm run environmental-burden:inventory
```

Outputs:

- `output/manifest.json` - machine-readable catalogue/resource metadata, size
  probes, counts, source URLs, and notes.
- `output/source-size-summary.md` - short human-readable size table.

Size caveats:

- NPRI byte sizes come from the ECCC Data Mart `path_contents` API because the
  Open Canada resource URLs route through the ECCC catalogue app.
- The Federal Contaminated Sites Inventory ZIP is official, but its host rejects
  the local non-browser probe used here; treat its data size as unknown until the
  downloader succeeds.
- EMS and EnMoDS are large. EMS exposes raw CSV and zipped alternatives; do not
  add both as required inputs without a deliberate storage plan.
- Groundwater wells use an ArcGIS record count plus a sampled GeoJSON-size
  estimate instead of downloading all well features.
