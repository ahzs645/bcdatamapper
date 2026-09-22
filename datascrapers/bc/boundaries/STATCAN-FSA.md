# BC 2021 census FSA snapshot

Run `npm run boundaries:fsa` from bcdatamapper. It downloads the versioned national ZIP to ignored `source/StatCanFSA`, extracts all 191 BC features and produces one deterministic compressed display layer and manifest in `output/StatCan`.

To use an existing archive: `npm run boundaries:fsa -- --archive=/absolute/path/lfsa000b21a_e.zip`. Use `--refresh` to refresh the standard source cache. The national source ZIP is 162.04 MB. Full BC geometry is 124.30 MB; display GeoJSON is 8.53 MB and gzip is 2.73 MB.

The layer is built once for reuse by all maps, keyed by CFSAUID under boundary dataset ID `statcan-cfsa-2021-bc`. It deliberately contains no MHCCA or CANUE metric columns. Keep thematic observations and aggregates in separate tables referencing this boundary version.

Validation requires Python with `shapely` and `pyproj`: `python validate-statcan-fsa.py`. It verifies 191 IDs, geometry validity, every feature pair for area overlaps, exact shared edge reuse and area differences in EPSG:3005. The accepted derivative has zero overlaps and a maximum area change of 1.6232% (V6C). Use full source geometry for analysis. Eight-decimal WGS84 precision prevents self-intersections introduced by six-decimal rounding. The manifest records source checksum, CRS, pinned Mapshaper version, method and 25 m display tolerance.

These are census-reported three-character FSAs, not six-character Canada Post delivery polygons. V7X and V7Y have no polygon in this release. See the reference guide URL in the manifest for source definitions and caveats.
