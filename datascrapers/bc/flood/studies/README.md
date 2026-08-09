# BC Flood Study Explorer research cache

The complete source, archive, licensing, validation, and deployment record is in
[`docs/flood-studies-and-snow-survey.md`](../../../../docs/flood-studies-and-snow-survey.md).

This scraper inventories the study areas exposed by ClimateReadyBC's Flood Study
Explorer, saves the polygons and normalized study records locally, probes the
official report/data-package links, and can download reasonably sized report
packages for project research.

The source catalogue record is licensed **Access Only**, not under the BC Open
Government Licence. Everything under `cache/` is therefore ignored by git. Do
not publish the polygons, reports, or data packages without confirming permission
and any study-specific third-party terms. A PGMaps project can instead query the
official feature service at runtime and link back to official/proponent material.

```bash
npm run flood-studies:sync
npm run flood-studies:sync -- --download-reports true --max-download-mib 50
npm run flood-studies:ecocat
npm run flood-studies:ecocat -- --download true --max-total-gib 18 --min-free-gib 8
npm run flood-studies:ecocat:audit
```

The first command refreshes `cache/studies.geojson`, `cache/studies.json`, and
`cache/manifest.json`, including HTTP availability and byte-size probes. The
second additionally downloads direct PDF/ZIP reports no larger than the cap into
`cache/reports/`. Existing complete downloads are retained. Report-data packages
are probed and inventoried but never downloaded by this command.

The separate EcoCat command crawls the legacy multi-document catalogue pages.
Its first form creates attachment manifests; `--download true` mirrors attachments
into `cache/ecocat/<study-id>/documents/`. Downloads resume from `.part` files,
retain per-study manifests and checksums, and stop at both a total-cache ceiling
and a free-disk-space floor.

The audit command reads the cached source pages and manifests without making
network requests. It restores EcoCat's report/map/data groupings, extracts
collection metadata, classifies display and download roles, and writes the
ignored `cache/ecocat/display-resource-audit.json`. Product findings and the
recommended sub-project resource UI are documented in
[`docs/ecocat-display-resource-audit.md`](../../../../docs/ecocat-display-resource-audit.md).

The official package inventory is large: at the August 2026 audit, only 27 of
166 report-package links responded, but those packages totalled about 13.3 GiB
and included a single 7.1 GiB ZIP. The cap is intentional.

Sources:

- Explorer: <https://climatereadybc.gov.bc.ca/pages/flood-study-explorer>
- Data catalogue: <https://catalogue.data.gov.bc.ca/dataset/2ca51dd6-cad1-455f-b772-ad770682be09>
- ArcGIS layer: <https://services1.arcgis.com/xeMpV7tU1t4KD3Ei/arcgis/rest/services/Flood_Studies_FGDB_20260331_164628_view/FeatureServer/0>

## Project direction

The strongest first project is a **Flood Study Library**, not a flood-hazard map.
Stream the official polygons at runtime and use them as an index into the studies.
Useful filters are report year/decade, proponent, consultant, FCL/near-FCL, and
report route. A study drawer can show its title, date, proponent, consultant,
official/proponent links, access status, and later report-derived fields such as
flood mechanism, modeled return periods, climate scenario, vertical datum, FCL,
DEM/LiDAR source, and available depth/velocity/elevation products.

The project should explicitly teach that coverage/index geometry is not inundation
or hazard extent. It should also preserve the conflict between the two official
descriptions: ArcGIS calls the polygons total study coverage, while the catalogue
says some records may be mapped from proponent location and may not represent the
study location. Any report-derived facts should retain document and page evidence.
