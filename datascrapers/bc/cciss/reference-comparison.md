# Offline comparison with a Shiny reference

`compare-pilot-reference.py` compares fields from an imported-data browser
assessment with the original Shiny result CSV. It reads local files and does not
contact a database, Shiny server or other service. There is no built-in real
current-site reference; the database owner must provide a matching run.

Run it from the bcdatamapper repository:

```sh
python datascrapers/bc/cciss/compare-pilot-reference.py \
  --browser /path/to/browser-assessment.json \
  --reference /path/to/cciss_export.csv \
  --reference-metadata /path/to/reference-metadata.json \
  --output /path/to/field-diff.json
```

The browser file is its exported `cciss-current-analysis-report-v1` JSON, including
the unrounded `calculation` object. A direct current assessment object with its
original numeric species and summary fields is also supported. A/B experiment
snapshots are a separate format; export the imported-data assessment JSON for
this command. The CSV may be gzip compressed. Limits match the browser workflow:
5 MB/50,000 reference rows, 25 MB browser JSON, and 1 MB optional reference metadata.

## Exact field identity

Every compared row has the key:

```text
[site, site series, species, original period ID or null, measure, class or null]
```

Rows align by these identities, never by position, species list order, coordinates
or a guessed period crosswalk. `--site` and `--series` explicitly filter the
comparison; selecting a nonexistent scope cannot report agreement.

| Measure | Compared values | Unit |
| --- | --- | --- |
| `vote` | Displayed class 1/2/3/X proportions for the exact period | Probability, 0–1 |
| `novelty` | Exported NOV proportion for the exact period | Probability, 0–1 |
| `baseline` | Curr suitability class | Class |
| `establishment` | Browser source summary and original EstabFeas | Class |
| `maturation` | Browser source summary and original ccissFeas | Class |
| `improve` | Browser source summary and original Improve percentage divided by 100 | Probability, 0–1 |
| `decline` | Browser source summary and original Decline percentage divided by 100 | Probability, 0–1 |

Source unsuitable labels X/4/5 compare as class 4; original CSV lexical values
remain untouched. The reference summaries are never recalculated from its votes.
Novelty-scaled display votes are compared as exported; neither input is divided
by its non-novel fraction. Missing fields remain unknown rather than zero.
Historical identifiers such as 1975/2000/2025/2055/2085 retain those exact values.

The default absolute probability tolerance is `1e-8`. `--tolerance` can explicitly
set a value from zero through `0.01` when assessing known CSV rounding. Suitability
classes always use zero tolerance. Maximum absolute differences are reported
separately for each measure; no maximum mixes probability and class units.

## Explicit SiteRef labels

Shiny may label a selected point with a SiteRef that differs from its database
site number. By default those identifiers remain unmatched. If the owner has
independently confirmed the relationship, an explicit mapping can be recorded:

```sh
python datascrapers/bc/cciss/compare-pilot-reference.py \
  --browser /path/to/browser-assessment.json \
  --reference /path/to/cciss_export.csv \
  --reference-site 'Owner-supplied SiteRef label' \
  --confirm-site-alias \
  --output /path/to/field-diff.json
```

This selects that single reference label and maps it only to the browser
assessment's declared site ID. Original reference site labels remain in each
diff row's `referenceSite`, and `alignment` records the user assertion. Site
series, species and period identifiers are still exact. The command refuses
alias confirmation without an explicit reference-site selection. A confirmed
alias does not independently verify locations, source inputs or model settings.

## Machine-readable result and exits

The diff schema is `cciss-shiny-reference-comparison-v1`, shared with the browser
reference comparator. Every field reports browser
and reference values, signed difference (browser minus reference), unit and one
of these statuses:

- `within-tolerance`: equal numeric values or probabilities within the explicit tolerance.
- `different`: paired values outside tolerance.
- `browser-missing`, `reference-missing`, `both-missing`: absent or null evidence.

`counts.matched` counts every paired numeric field, including differences.
`counts.withinTolerance` counts paired fields that agree within the allowed
tolerance. The other count names are `different`, `missingBrowser`,
`missingReference`, and `bothMissing`.

The report includes counts, original period sets, per-measure maximum differences,
version/settings metadata checks, selection/alignment, and each input's filename,
decompressed byte count and SHA-256. The reference receipt also includes its exact
columns and row count. Original inputs are never modified.

Exit 0 means `fieldsAgree: true`: at least one paired numeric field and every
selected field equal or within tolerance, with no missing fields. Exit 1 means
differences, missing evidence, or no paired numeric fields. Exit 2 means malformed
inputs or invalid options. Metadata/context checks are reported separately;
even exit 0 always has `scientificParityVerified: false`.

Optional reference metadata describes the actual owner-supplied run. Provide
`datasetVersion`, full `ccissrCommit` and `shinyCommit`, a source/delivery reference,
and a `settings` object matching the browser export's selection. Settings include
the site/site-series choice, all model/scenario weights, establishment/maturation
period weights, novelty cutoff and out-of-range setting. Additional owner review
fields may be retained as provenance. Absent metadata or differing settings
produce an explicit warning; an assertion is not independent verification.

## Independent synthetic regression reference

`fixtures/synthetic-current-reference.csv` contains hand-constructed expected
values for the existing synthetic pilot, and
`fixtures/synthetic-current-reference-metadata.json` records its deliberately
artificial source and settings. The file uses the Shiny CSV shape but was **never
exported by a real Shiny run**. Its invented TEST labels and `synthetic: true`
metadata are preserved in tests and warnings.

For equal model/scenario weights and no novelty filter, all historical/2021
TESTa votes are High. In each later period half the votes are Moderate and half
Unsuitable, so its default maturation score is
`0.1 × 1 + 0.9 × (0.5 × 2 + 0.5 × 5) = 3.25`, which yields class 3. Only the first
of four maturation periods is improving/stable relative to its High baseline,
giving 25% improving/stable and 75% declining/unsuitable. TESTb has score 2 in
every period; its improving/stable proportion is 62.5%, source-rounded to 62,
with 38 declining/unsuitable under ties-to-even rounding. These literal expected
values are not generated by the browser summary implementation.

```sh
python datascrapers/bc/cciss/test-comparison-reference.py
```

The dependency-free tests cover the independent expected fields, exact site and
period identity, explicit aliasing, source summaries, tolerance, class handling,
novelty scaling, nulls, duplicate/corrupt inputs, metadata, CLI exit codes, and
the unchanged published historical Williams Lake CSV's actual period IDs.

## Required authentic owner bundle

Request these artifacts together for a bounded set of contrasting real sites:

1. A version-matched pilot export of future/observed/novelty arrays, ordered
   dimensions, BGC codebook/attribution and exact site geometry.
2. The deployed ccissr commit/build and its matching ecological tables, plus
   the Shiny app commit and model/data versions.
3. The original Shiny CSV/RDS results and session settings for the same selected
   coordinates, sites and site series, with all weights/cutoffs/options recorded.
   Keep CSV output unchanged, including any NOV fields and original summaries.
4. `dbPointInfo` outputs and, where SiteRef is a user label, a documented mapping
   to the exported site number. Confirm coordinate precision and boundary cases.
5. The browser assessment JSON from those exact inputs/settings, followed by
   independent review of the field diff and any source-specific differences.

The latest inspected public trees remain ccissr development
`a6ab8ee3a714ebf4a3f41e16f04d9f58404de7ce` and Shiny main
`3d602d430d15ab74a341c63b31bbf6b1bc22ec31`. They provide the older Williams Lake
examples but no newly available authentic current pilot/result fixture. The
historical example can verify parsing and period preservation; it cannot
establish current-model parity or validate the synthetic ecological rows.
