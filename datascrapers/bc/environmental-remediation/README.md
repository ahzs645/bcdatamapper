# Environmental Remediation Sites

From PGMaps, run `npm run remediation:sync` (Python standard library only).
From this directory, the equivalent is `python3 download.py`.
Downloads the complete provincial WFS layer, paged by stable site ID, to ignored
`cache/` GeoJSON and deterministic gzip. All attributes are retained; geometry is
unchanged apart from the server's conversion to longitude/latitude (CRS84).
Validates completeness, unique site IDs, point geometries, and coordinate ranges
before saving data. The cache includes source metadata and a SHA-256 manifest.
Transient network errors are retried up to three times.

`npm run remediation:sync -- --from-cache` rebuilds the map product without
downloading again. The map product preserves every source coordinate and uses
registry `SITE_ID` as its stable identifier, dropping volatile WFS and object IDs.
It retains name, address, location notes and both file numbers. No status is
inferred. The deterministic gzip is named by its uncompressed SHA-256; the
manifest is replaced last so the UI does not see a partially updated product.

In PGMaps, open `/misc?tab=remediation` in the development server. The Remediation
tab offers clustered points, province-wide text search, site details and BC / Prince
George camera shortcuts. `scripts/remediation-dev-data.ts` serves only the
manifest and content-addressed map products; it is not active in production.
Neither the tab nor cached data is deployed. No copy to `public/data` is required.

Validation: `python3 -m unittest discover -s datascrapers/bc/environmental-remediation -p 'test_*.py'`
from the bcdatamapper root. The browser checks the map payload's SHA-256 and count.

Source: https://catalogue.data.gov.bc.ca/dataset/environmental-remediation-sites

The catalogue labels this dataset **Access Only**. This is a local research
download, not a public deployment or redistribution package. No ParcelMap joins
have been performed. The linked provincial copyright policy requires written
permission for reproduction of Access Only material; public deployment is not
enabled by this integration.

These are site location points for known and potentially contaminated properties,
not surveyed contamination extents or a declaration that every listed property
is currently contaminated. Parcel associations need separate validation.
