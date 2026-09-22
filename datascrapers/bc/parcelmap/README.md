# ParcelMap BC source pull

Download the official province-wide open ParcelMap BC File Geodatabase:

```sh
npm run parcelmap:sync
# Optional alternate dataset with individual building strata lot PIDs:
npm run parcelmap:sync -- --dataset fabric
```

The Python standard-library downloader resolves the current archive URL from the
BC Data Catalogue, streams to a temporary file, verifies its byte count and all ZIP
CRCs, and only then replaces the local archive. It records the licence, source CRS,
retrieval date, upstream modification date, sizes and SHA-256 in
`output/polygons-manifest.json` (or `fabric-manifest.json`). Large raw archives live
under ignored `source/`; the manifests and downloader belong in this repository.
Run the command again to refresh the snapshot. Downloads retry up to three times.

Inspect the geodatabase without extracting it (optional GDAL/pyogrio dependency):

```sh
uv run --with pyogrio==0.13.0 python datascrapers/bc/parcelmap/inspect-parcelmap.py
python3 datascrapers/bc/parcelmap/test_sync_parcelmap.py
```

The inspection writes `output/polygons-inspection.json` with its archive checksum,
actual feature count, CRS, extent and schema. Run it again after each refresh;
the checksum distinguishes an old inspection from the current download. This
checks that the geodatabase is readable, not the validity of every parcel shape.

The pull is the source dataset, with no simplification, clipping, coordinate rounding,
or housing-suitability filtering. It is not an app deployment or tile build.
No files are copied into PGMaps `public/data` by this command.

## Initial public-land screen

```sh
npm run parcelmap:public-land
# Refresh exclusion sources as well (parcel archive refresh is a separate command):
npm run parcelmap:public-land -- --refresh
uv run --with pyogrio==0.13.0 --with shapely==2.1.2 python datascrapers/bc/parcelmap/test_public_land.py
```

This reconstructs the initial public-ownership / reserve / parks exclusion stage
of the BCPLM methodology using current full-resolution sources. See
`output/public-land/report.md` for results, exact choices and remaining work.
Summary JSON and the region-by-owner CSV are tracked; source masks, per-parcel
decisions and the candidate GeoPackage stay in ignored `source/public-land/`.
The national park mask is catalogued Access Only, so this workflow is a local
research build and does not publish source or candidate geometries to the app.

Region assignment uses ParcelMap BC's existing region attribute rather than a
new spatial join to legal district polygons; this preserves Northern Rockies and
Stikine as reporting units. Any intersection removes the whole parcel, including
boundary contact. Conservancy exclusions are measured separately because they
are a distinct source layer not explicitly identified by UBC. Invalid geometries
are repaired only for spatial predicates, with counts reported; the GeoPackage
preserves original geometries. Thus it can still contain invalid source shapes.

## Choosing the dataset

- **Polygons**: physical parcel representation; building strata are represented
  once per strata plan, without every individual strata lot PID. Includes PID,
  PIN, parcel class/status, owner category, municipality and regional district.
- **Fabric**: includes distinct records with stacked geometry for individual
  building strata parcels. Use this, or the published shared-geometry cross-reference
  table, when matching individual strata PIDs to assessment records. Overlapping
  geometries in the fabric can be intentional and must not be dissolved blindly.

Neither open dataset contains assessment values or individual owner names.
Ownership category is different from the identity of an owner. Use PID strings
with leading zeros preserved for joins; validate cardinality and geometry before
joining BC Assessment data. The survey plan and registry remain authoritative for
legal boundaries and records.

Sources:

- [Parcel Polygons catalogue](https://catalogue.data.gov.bc.ca/dataset/2f4117d9-41fc-44db-87d4-dbdb77f14086)
- [Parcel Fabric catalogue](https://catalogue.data.gov.bc.ca/dataset/4cf233c2-f020-4f7a-9b87-1923252fbc24)
- [Shared Geometry Cross Reference](https://catalogue.data.gov.bc.ca/dataset/b918901e-9fd3-4f01-803d-eaeca027b794)

Published under the Open Government Licence – British Columbia. Attribute to
ParcelMap BC / Land Title and Survey Authority of British Columbia, distributed
by DataBC, when deriving or displaying this data.
