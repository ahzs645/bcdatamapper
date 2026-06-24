# Bell Coverage Raster Polygonization

Bell's public coverage map does not expose native vector polygons in the inspected
app. It renders Google Maps `ImageMapType` PNG coverage tiles from Korem:

```text
https://bellmaps.korem.com/TMS/getTile?workspace=Bell.ca&layers=...&z=...&x=...&y=...&timestamp=...
```

This scraper preserves that public raster source and converts non-transparent tile
pixels into approximate GeoJSON rectangle polygons. The output is suitable for
visual comparison against CRTC/TELUS coverage, but it is not a native Bell vector
dataset.

## Run

```bash
npm run network:bell:sync -- --max-zoom 8 --layers 4g-lte,5g-lte
npm run network:bell:sync -- --max-zoom 8 --layers all-types
```

Useful options:

```text
--min-zoom 4              Lowest Google map zoom to request.
--max-zoom 8              Highest Google map zoom to request. Bell's app caps at 12.
--layers 4g-lte,5g-lte    Layer groups from Bell's site config.
--layers all-types        Pull individual technology layers.
--step all                all, download, or polygonize.
--force                   Redownload existing tiles.
--concurrency 4           Parallel tile requests.
--min-alpha 16            Ignore mostly transparent pixels during polygonization.
--min-color-pixels 32     Drop tiny per-tile color specks.
```

Bell's tile URL uses one-based source coordinates and `sourceZ = mapZoom + 1`.
Files are stored with normal zero-based Google/XYZ map coordinates:

```text
output/tiles/<layer>/<mapZoom>/<x>/<y>.png
output/polygons/<layer>.geojson.gz
output/manifest.json
```

Layer IDs:

```text
Grouped UI buckets:
5g-lte       5G_PLUS_Advanced,5G_PLUS,5G
4g-lte       LTE_Advanced,LTE
4g-hspa      HSPA
lte-m        LTE_M

Individual technology layers:
5g-plus-advanced   5G+ Advanced (5G+A)
5g-plus            5G+
5g                 5G
lte-advanced       LTE Advanced (LTE-A)
lte                LTE
hspa               HSPA+
lte-m              LTE-M
```

## Limits

- This is a lossy raster-to-vector approximation.
- It does not dissolve rectangles across tile boundaries yet.
- Higher zooms grow quickly. Approximate candidate tile counts for Bell's public
  Canada bounds are:
  - z4-z8: about 1,705 tiles per layer group
  - z4-z9: about 6,581 tiles per layer group
  - z4-z10: about 25,717 tiles per layer group
- The default skips fully transparent tiles and writes only non-empty PNGs.
