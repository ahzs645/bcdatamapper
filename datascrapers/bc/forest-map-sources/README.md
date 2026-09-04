# BC Forest Map source rebuild notes

Most scripts in this directory are intentionally source plans, not data
downloaders. The BigTree Registry also has a reviewed snapshot importer because
UBC's bot protection can block unattended downloads of its otherwise public CSV.

Use them to keep BC Forest Map-derived layers anchored to direct upstream
sources before implementing full sync jobs. The current downloaded tile mirror
under Google Drive is a useful reference, but it is a processed Mapbox snapshot.
For reproducible bcdatamapper sources, prefer the direct sources documented
here.

Run any script with `node <script>` to print the intended source plan and output
contract. Do not make these scripts fetch large datasets until the matching
normalizer, clipping policy, and output location have been reviewed.

## BigTree Registry snapshot

Import a GeoJSON snapshot with:

```sh
npm run bcforestmap:big-tree-registry:import -- \
  --input /absolute/path/to/bc_bigtree_registry.geojson \
  --snapshot-date 2026-07-02
```

The importer validates point geometry and unique registry identifiers, rounds
coordinates, converts measurement fields to numbers, derives the story-map
display fields, sorts features by registry ID, and writes the deterministic
deployable snapshot to `output/bc_bigtree_registry.geojson`. Run it twice with
the same input and snapshot date to verify byte-for-byte determinism.

The UBC Registry Reports CSV remains the preferred upstream source. The current
output records that the supplied BC Forest Map GeoJSON was used as a fallback,
along with the input SHA-256 digest and upstream UBC links.

## iNaturalist species-at-risk snapshot

Import the supplied BC Forest Map vector-tile mirror with:

```sh
npm run bcforestmap:inaturalist-species-at-risk:import -- \
  --input /absolute/path/to/inaturalist_species_at_risk \
  --snapshot-date 2021-07-28
```

The importer reads the maximum-zoom PBF tiles, deduplicates observations by
iNaturalist observation ID, flattens the embedded taxon JSON, derives map-ready
taxonomic-group, observation-period, positional-accuracy, and observation-frequency
bands, and writes `output/species-at-risk/inaturalist_species_at_risk.geojson`.
For cloud-backed folders where recursive directory enumeration is slow, pass a
newline-delimited list of hydrated PBF paths with `--tile-list /path/to/list.txt`.

This is a historical, processed snapshot. Its Tippecanoe recipe selected records
with `threatened=true` and positional accuracy below 100 metres. That selection is
not an official B.C. or federal legal designation, and observation density must not
be interpreted as abundance, habitat, or confirmed absence.

### Live API snapshot

Create a current, dated snapshot from the supported iNaturalist API with:

```sh
npm run bcforestmap:inaturalist-species-at-risk:sync -- \
  --snapshot-date YYYY-MM-DD
```

The live sync uses iNaturalist place 7085 (British Columbia), research-grade
observations, positional accuracy below 50 metres, taxa flagged threatened,
open taxon geoprivacy, and taxonomic ranks at genus or below. It requests 200
records at a time, follows the API's `id_above` cursor guidance, waits at least
one second between requests, and can resume an interrupted run with `--resume`.

Dated outputs are deterministic `*.geojson.gz` files accompanied by a manifest;
temporary checkpoints live under the ignored submodule `tmp/` directory. A live
snapshot is not equivalent to the July 2021 vector-tile reconstruction, and the
same interpretation cautions apply.

## Source mapping

| BC Forest Map layer | Direct source to use | Notes |
| --- | --- | --- |
| VRI forest data | BC Gov VRI 2025 FGDB ZIP, or BCGW WFS `WHSE_FOREST_VEGETATION.VEG_COMP_LYR_R1_POLY` | BC Forest Map used an older processed VRI tileset. Current direct source is 2025; use only if current data is acceptable. |
| Planned logging, RESULTS openings | BCGW WFS `WHSE_FOREST_VEGETATION.RSLT_OPENING_SVW` | Apply BC Forest Map filter: recent `APPROVE_DATE`, null `DISTURBANCE_END_DATE`, positive `FEATURE_AREA`, no denudation/planting counts. |
| Planned logging, FTA cutblocks | BCGW WFS `WHSE_FOREST_TENURE.FTEN_CUT_BLOCK_POLY_SVW` | Apply planned harvest date window and active-ish lifecycle/status filtering before publication. |
| Species at risk habitat | BCGW WFS `WHSE_TERRESTRIAL_ECOLOGY.BIOT_OCCR_NON_SENS_AREA_SVW` plus federal SARA source | The BC Forest Map tileset is a combined derivative. Implement BC CDC first, then add SARA once the federal spatial source is pinned. |
| iNaturalist species at risk | iNaturalist observations API | API results are live/current. Persist a dated snapshot if reproducibility matters. |
| BC BigTree Registry | UBC BC BigTree Registry reports page | UBC publishes registry reports as xlsx/csv from the reports page. Prefer that over BC Forest Map's embedded snapshot. |
