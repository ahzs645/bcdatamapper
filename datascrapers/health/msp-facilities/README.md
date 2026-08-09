# BC MSP facility map output

This scraper joins facility-like payees from the BC MSP Blue Book SQLite
database to public BC health-service provider layers and the BC Address
Geocoder. The deployable GeoJSON and deterministic geocoding cache live in
`output/` and are copied into PGMaps by `scripts/sync-bcdatamapper-data.mjs`.

Run it from PGMaps with either command:

```bash
npm run health:msp-facilities
npm --prefix vendor/bcdatamapper run health:msp-facilities
```

The source database is the recursively initialized health-data submodule at
`data-sources/healthdata/bc_msp_blue_book/bc_msp_blue_book.db`.
