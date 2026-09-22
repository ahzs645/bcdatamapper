# MHCCA prepared CVI inputs and audit

This release preserves the public dashboard CSV downloaded on 22 September 2026, its 80-entry source catalogue, and a manually reviewed crosswalk to Tables 1–2 of the CVI report. It does not contain final CVI scores or recreate the primitive sources. Report attribution: Alexi T. Hu and Kiffer G. Card, *Developing and Validating a Climate Vulnerability Index for British Columbia*. Public report: https://mhcca.ca/s/CVI-Report.pdf . Dashboard: https://alexihu.shinyapps.io/ClimateVulnerability/ . Download provenance and checksums are under `source/`.

Run `python3 build.py` with NumPy installed. The build validates the source checksum, 193 unique FSA rows, all 76 numeric fields, the 80-row catalogue and finite values. It joins only boundary codes to record availability; output contains no geometry. Preserve all 193 rows for PCA diagnostics, including V7X/V7Y without matching 2021 FSA polygons.

The `EXCLUDED`, `AMBIGUOUS`, `PROJECTED`, `CANDIDATES` and `NOTES` definitions in the builder are the reviewed audit crosswalk. Eleven mappings are intentionally ambiguous: postsecondary versus university education, and ten rate/count fields behind five repeated disease-incidence labels. A newer source export must be reviewed explicitly rather than bypassing the checksum assertion.

`output/inputs.json` drives the PGMaps input map and audit panel. `variable-audit.csv` covers all 80 entries; `reproducibility.json` records standardized exposure PCA checks that do not match the report; `holdings-evidence.json` retains inspected catalogue checksums and candidate metadata. `manifest.json` records file hashes. Values are author-prepared, already averaged, aggregated and/or imputed. This does not establish redistribution rights for the underlying restricted datasets, none of which are included here.

PGMaps syncs output to `/data/climate-vulnerability` and loads polygons separately from the canonical `statcan-cfsa-2021-bc` boundary set. See PGMaps `docs/cvi-variable-and-reproducibility-audit.md` for the full assessment. No R2 upload is part of this release.
