# BC Snow Survey Administrative Basins

This boundary family contains the Province's 23 Snow Survey Administrative Basin
Areas. The areas support Snow Survey Network station naming and snow-program
reporting. They are not interchangeable with Freshwater Atlas watersheds.

Refresh and compare them with:

```bash
npm run snow-survey-basins:sync
npm run snow-survey-basins:compare
```

The canonical output is:

```text
datascrapers/bc/boundaries/output/BCSnowSurvey/
  comparison.json
  snow_survey_admin_basins.geojson
```

The sync reads the official BCGW layer in its native BC Albers CRS (EPSG:3005),
simplifies all 23 polygons together as shared topology at a 25 metre tolerance,
and emits WGS84 GeoJSON. It requires all 23 basin IDs, names, and slugs to be
unique. The output embeds source, licence, CRS, simplification, vertex, lineage,
and area-deviation metadata.

The comparison covers 13 existing BC Data Mapper boundary families. It uses
intersection-over-union (IoU) to detect near-duplicate features and calls a whole
family equivalent only when all 23 basins map one-to-one at IoU 0.98 or above.
No existing family passed that rule.

Important interpretation:

- Two of the nine broad BC Drainage features closely match individual Snow
  Survey basins, but the complete families differ.
- No FWA major-watershed or watershed-group feature reaches the 0.98 duplicate
  threshold after comparison with the authoritative Snow Survey polygons.
- A typical Snow Survey basin contains material pieces of six FWA watershed
  groups; the range is one to 38.
- Reused regional names do not imply reused geometry. For example, same-name
  health and watershed features often cover very different areas.
- Spatial similarity cannot establish historical lineage. The official catalogue
  only states that the linework was updated on May 15, 2019; it does not identify
  FWA or another BC Data Mapper boundary as the parent.

Sources:

- Catalogue: <https://catalogue.data.gov.bc.ca/dataset/9ec01cdb-7085-44fe-b059-9fe5aefb7497>
- BCGW layer: `WHSE_WATER_MANAGEMENT.SSL_SNOW_SURVEY_BASIN_AREA_SP`
- Licence: Open Government Licence – British Columbia
