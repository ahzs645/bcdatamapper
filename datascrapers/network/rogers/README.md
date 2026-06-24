# Rogers Coverage Probe

Rogers' public coverage map embeds a SpatialBuzz coverage checker rather than
exposing first-party vector coverage files in the page HTML.

Public page:

```text
https://www.rogers.com/mobility/network-coverage-map
```

Observed embed:

```text
https://rog-ca.spatialbuzz.net/cust/593E2268/public/init/bootstrap-coverage-593E2268-272F320D-outer-init.js
https://rog-ca.spatialbuzz.net/cust/593E2268/rog-ca-integration-hdcoverage-consumer-iframe-src.html
```

The live map uses 256 px PNG XYZ raster coverage tiles from SpatialBuzz:

```text
https://593e2268-tiles.spatialbuzz.net/tiles/rog_ca-v202/styles/<style>/{z}/{x}/{y}.png
```

This means Rogers is closer to Bell's public map than TELUS:

- TELUS exposes Carto/deck.gl vector tiles.
- Bell exposes raster PNG coverage tiles.
- Rogers exposes SpatialBuzz raster PNG coverage tiles.

The source is still useful for comparison, but any polygon output from this
source would be a raster-to-vector approximation unless Rogers exposes a
separate vector export elsewhere.

## Run

```bash
npm run network:rogers:probe
npm run network:rogers:sync
npm run network:rogers:derive
```

Useful options:

```text
--headed                 Open Chrome visibly while probing.
--timeout-ms 30000       Maximum time to wait for config/tile traffic.
--sample-tile            Download one observed PNG tile into output/sample-tile.png.
```

Sync options:

```text
--min-zoom 3             Lowest XYZ zoom to request.
--max-zoom 8             Highest XYZ zoom to request. Source layers advertise 1-18.
--layers 4g5g,4g         Comma-separated layer ids. Defaults to 4g5g,4g,3g,ltem,nbiot,comp_sat.
--bounds w,s,e,n         Default is Canada-focused: -142,41,-52,84.
--force                  Redownload existing tiles for the current coverage version.
--concurrency 8          Parallel tile requests.
--min-alpha 16           Ignore mostly transparent pixels.
```

The script writes:

```text
output/manifest.json
output/config.json
output/sample-tile.png   only with --sample-tile
output/tiles/<layer>/<z>/<x>/<y>.png
output/tiles/<layer>/layer-download-manifest.json
output/tiles/sync-manifest.json
```

## Observed Layers

The probe captured coverage data version `rog_ca-v202` with coverage updated
`12/06/2026`.

Each useful layer advertises `zoomRangeFrom: 1` and `zoomRangeTo: 18` in the
SpatialBuzz config. The sync script intentionally defaults to zooms 3-8 because
pulling the full configured zoom range across Canada would be too large for a
local snapshot.

```text
layer_id   style                label
comp       rog_ca_v202_comp     All Coverage
4g5g       rog_ca_v202_4g5g     5G/5G+
4g         rog_ca_v202_4g       4G LTE
3g         rog_ca_v202_3g       HSPA+
ltem       rog_ca_v202_ltem     LTE-M
nbiot      rog_ca_v202_nbiot    NB-IoT
comp_sat   rog_ca_v202_sat      All Coverage, including satellite
```

The config also includes Fido and chatr layers:

```text
fcomp      rog_ca_v202_fcomp    Fido All Coverage
f4g5g      rog_ca_v202_f4g5g    Fido 5G
f4g        rog_ca_v202_f4g      Fido LTE
f3g        rog_ca_v202_f3g      Fido HSPA+
f5g        rog_ca_v202_f5g      Fido 5G
23g        rog_ca_v202_23g      chatr Network and Nation-Wide Plans
dzo        rog_ca_v202_dzo      chatr In-Zone Plans
```

For PGMaps network comparison against CRTC, start with Rogers `4g5g`, `4g`,
`3g`, and `ltem`. The `comp` layer is an overall composite and is less useful
when comparing specific technologies.

## Local Snapshot

Pulled on 2026-06-23 with:

```bash
npm run network:rogers:sync -- --min-zoom 3 --max-zoom 8 --layers 4g5g,4g,3g,ltem,nbiot,comp_sat --concurrency 12
```

Requested extent:

```text
west=-142 south=41 east=-52 north=84
```

Candidate tiles per layer: 7,808.

```text
layer      source zooms   pulled zooms   saved tiles   png bytes
4g5g-only  1-18           3-8            448           4.36 MB
5g-only    1-18           3-8            448           3.96 MB
5g+ only   1-18           3-8            357           1.40 MB
4g5g       1-18           3-8            2,582         11.17 MB
4g         1-18           3-8            2,582         10.10 MB
3g         1-18           3-8            2,546         9.50 MB
ltem       1-18           3-8            2,562         9.90 MB
nbiot      1-18           3-8            2,475         9.44 MB
comp_sat   1-18           3-8            3,046         12.07 MB
```

Raw pulled source tiles: 15,793 PNG tiles, 62.17 MB of PNG bytes, 0 failed
requests.

The public Rogers `4g5g` style is not pure 5G. Its own legend contains 5G+,
5G, and 4G LTE. The local `4g5g-only` layer is the recommended dev-map layer:
it is derived by subtracting the matching `4g` PNG tile from each `4g5g` PNG
tile and dropping non-red artifacts. The scraper can also emit `5g-only` and
`5g-plus-only`, but those are kept as diagnostic layers rather than surfaced in
the dev map by default.

## Limits

- The source is PNG raster, not native vector.
- The inspected app traffic and bundled code use Google Maps `ImageMapType`
  overlay PNGs for coverage. I did not find MVT/PBF/GeoJSON/shapefile coverage
  equivalents exposed by the public Rogers map.
- The config request uses a browser session/auth suffix, so the probe captures
  the live app traffic instead of hard-coding the config URL.
- Higher zoom pulls grow quickly, like Bell. A future sync script should first
  mirror selected PNG layers, then optionally polygonize them with the same
  lossy raster-to-vector process used for Bell.
