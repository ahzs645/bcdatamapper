# Environmental Remediation Sites

From PGMaps, run `npm run remediation:sync` (Python standard library only).
From this directory, the equivalent is `python3 download.py`.
Downloads the complete provincial WFS layer, paged by stable site ID, to
`source/environmental-remediation-sites.geojson.gz`. All attributes are retained; geometry is
unchanged apart from the server's conversion to longitude/latitude (CRS84).
Validates completeness, unique site IDs, point geometries, and coordinate ranges
before saving data. `source/manifest.json` records download time, request URLs,
counts, sizes and SHA-256 checksums of both the gzip and decompressed GeoJSON.
`source/catalogue-metadata.json` preserves the source catalogue metadata.
The compressed source payload is ignored by Git; provenance files are tracked.
The source archive remains local in bcdatamapper because it is Access Only.
No uncompressed source file is written by new downloads.
Transient network errors are retried up to three times.

`npm run remediation:sync -- --from-cache` rebuilds the map product without
downloading again: it reads the compressed source, validates both checksums and
builds the derived map files in ignored `cache/`. It also supports the original
uncompressed cache layout if no source archive is present.
The map product preserves every source coordinate and uses
registry `SITE_ID` as its stable identifier, dropping volatile WFS and object IDs.
It retains name, address, location notes and both file numbers. No status is
inferred. The deterministic gzip is named by its uncompressed SHA-256; the
manifest is replaced last so the UI does not see a partially updated product.

In PGMaps, open `/misc?tab=remediation`. The Remediation tab offers clustered
points, province-wide text search, site details and BC / Prince George camera
shortcuts. In development, `scripts/remediation-dev-data.ts` serves the local
manifest and content-addressed map product. The live test site reads the same
map product from `https://data.map.ahmad.sh/bc/environmental-remediation/v1/`.
The source archive and cache are not copied to PGMaps `public/data`.

Validation: `python3 -m unittest discover -s datascrapers/bc/environmental-remediation -p 'test_*.py'`
from the bcdatamapper root. The browser checks the map payload's SHA-256 and count.

Source: https://catalogue.data.gov.bc.ca/dataset/environmental-remediation-sites

The catalogue labels this dataset **Access Only**. The personal test site now
serves the derived map snapshot from R2; the original source archive remains
in private storage. No ParcelMap joins have been performed. The linked
provincial copyright policy requires written permission for reproduction of
Access Only material.

These are site location points for known and potentially contaminated properties,
not surveyed contamination extents or a declaration that every listed property
is currently contaminated. Parcel associations need separate validation.
