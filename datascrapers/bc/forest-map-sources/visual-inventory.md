# Downloaded BC visual inventory

Run `node --max-old-space-size=8192 datascrapers/bc/forest-map-sources/sync-visual-inventory.mjs` from bcdatamapper. Add `--refresh` to replace cached source pages. The downloader verifies the service count, source identifiers and every page before publishing. It uses four concurrent requests and retries transient failures twice. Source pages are cached locally in `source/visual-inventory/`; deterministic deployable snapshots belong in `output/visual-inventory/`.

Source: DataBC forest vegetation MapServer layer 6, Visual Landscape Inventory — Visual Sensitivity Units — View. Licence: Open Government Licence — British Columbia. Geometry is WGS84 as returned by the service; it is neither reprojected, rounded nor simplified. Only the fields needed for identification, objectives, sensitivity, VAC and provenance are downloaded. `retrievedAt` describes the download, not the age of individual inventory observations.

The current service returns 10,000 features. The snapshot contains a compressed bounding-box index and 100 spatially ordered geometry shards of 100 units each. Approximately 206 MB of JSON compresses to 75 MB total. The application downloads the index and shards intersecting a bounded search, not the province on each lookup. Every shard is below the script's 20 MiB limit and can be served as an ordinary static file without a Worker, R2 bucket or upstream proxy. The manifest includes file hashes, record counts, source URL and source dates.

A trial shared-topology 30 m simplification distorted small units, so no simplification is shipped. Validation compares every output geometry to the source, checks IDs, measures shared edges and evaluates polygon-area overlaps for every intersecting pair:

```
uv run --with shapely==2.1.2 --with pyproj==3.7.2 python datascrapers/bc/forest-map-sources/validate-visual-inventory.py
```

The current validation finds 48 source overlap pairs greater than 1 m² and seven invalid source geometries. They are preserved exactly: zero introduced overlap pairs, zero area change, and 1,230,858 exact shared edges. This is a thematic inventory with gaps and overlaps, not a provincial partition. Candidate boundaries still require visual/geometry review. `validation.json` records the measurements. A repeat build from the same source pages produces the same manifest and compressed-file hashes.

PGMaps copies this folder to `public/data/forest/visual-inventory` through its data sync script. Do not commit generated copies to PGMaps. Commit and push this submodule before updating the parent pointer. The browser's nearby GeoJSON download exports the loaded search envelope, while this pipeline stores the entire published layer.
