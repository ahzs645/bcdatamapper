# Nechako public submission content

This scraper builds the compact, searchable **public** submission snapshot used by PGMaps. It refreshes directly from the anonymous source without administrator credentials. An optional private, administrator-visible export narrows the ID/state cohort only. Its values, administrative catalogue text, drafts, permissions and assigned-user metadata are never copied into the deployed snapshot.

Each candidate must appear as `SUBMITTED` in a fresh anonymous native `getSearchResults.php` response. When `--seed` is supplied, candidates must also belong to that seed's submitted ID set. Every included form definition, field value and attachment/layer inventory must come from a successful native response with **`loggedIn: false`**. Bulk fields come from anonymous `GetFormStatistics.php`; omitted bulk fields are independently read with `getFieldValue.php`. Failed reads are omitted and counted rather than populated from the private seed. The anonymous catalogue is checked again after capture; changed IDs, eligible submission states or form associations stop publication, even when all IDs remain present.

## Run

```sh
python3 snapshot.py --workers 4
python3 snapshot.py --seed /absolute/path/to/private-export --workers 4
python3 forms.py
python3 -m unittest discover -s . -p 'test_*.py'
```

Workers are bounded to 1, 2 or 4. There are no login, upload, save, delete or other mutation routes. Ordinary reads are bounded to 20 MiB; the two rich-content routes are bounded to 128 MiB because native form content may contain large inline images. No source response envelopes, cookies, credentials or private export files are written here. Network read failures are retried once; omitted fields/inventories remain explicit in the manifest. The manifest must be reviewed before deploying a partial capture.

`--captured-at <ISO timestamp>` pins the metadata timestamp for reproducible rebuilds of otherwise identical source content. JSON uses stable record order, UTF-8 and compact separators. Gzip uses compression level 9 with `mtime=0`, without a source filename; identical JSON bytes produce identical compressed bytes.

`forms.py` refreshes form layout metadata only. It reads the form IDs already present in the public content snapshot, freshly verifies those records remain anonymously submitted with the same form associations, and reads their definitions through anonymous `getForm.php`. It does not use the private export or recapture submission field values. The existing content gzip is checked for byte identity. A normal full `snapshot.py` capture also emits the corresponding definitions automatically.

## Output contract

`output/manifest.json` has schema `nechako-public-content-manifest-v1`, source, capturedAt, scope, recordCount, fieldCount, mediaCount, attachmentCount, layerCount, omissions, verification and limitations. `files["submissions.json.gz"]` contains compressed/uncompressed byte counts and SHA-256 hashes. Verification records the anonymous search count, `seedApplied`, excluded seed draft count, permitted read methods and successful final catalogue recheck. Without a seed, `seedSubmittedCount` is null and the scope explicitly describes a fully anonymous source refresh.

`output/submissions.json.gz` decompresses to:

```json
{
  "schema": "nechako-public-content-v1",
  "source": "https://nechakowatershed-portal.ca/",
  "capturedAt": "ISO timestamp",
  "records": [{
    "id": "original submission ID",
    "title": "anonymous submission title",
    "name": "anonymous submission name",
    "formId": "original form ID",
    "formName": "anonymous form name",
    "date": "original anonymous date value",
    "submittedBy": "optional anonymous public submitted_by value",
    "parentId": "optional original anonymous parent_id value",
    "sourceType": "optional submission or activity",
    "sourceUrl": "https://nechakowatershed-portal.ca/",
    "fields": [{"id": "original field ID", "label": "source label", "type": "source type", "value": "sanitized source value"}],
    "attachments": [{"id": "source file ID", "name": "public name", "sourceUrl": "original portal", "url": "optional actual safe HTML href"}],
    "layers": [{"id": "source layer ID", "name": "public name", "kind": "direct or linked", "schemaId": "optional source schema ID", "sourceUrl": "original portal"}],
    "media": [{"fieldId": "source field ID", "ordinal": 1, "mime": "media MIME type", "kind": "embedded or remote", "sourceUrl": "original portal", "sha256": "embedded media digest only", "url": "remote URL only"}],
    "searchText": "plain searchable title/form/field/reference text"
  }]
}
```

Native parent `-1` is a submission; other present parent values follow the original activity convention. Omitted parent metadata never implies a type. `submittedBy` is included only because it is returned publicly in the anonymous source search table; unrelated administrative identities are excluded.

## Public form definitions

`output/forms.json.gz` decompresses to `{schema:"nechako-public-form-definitions-v1",source,capturedAt,forms:[...]}`. Each form has `id`, `name`, `pages:[{id,label?}]`, and `nodes` in the exact source array order. Each node carries `fieldId?`, `label`, `type`, `dynamic`, `page`, `nodeRank`, `fieldRank`, `nodeType`, `nodeName?`, and `semanticType`. Numeric/string ranks retain their source types and zero values. Contiguous dynamic fields can be grouped using their native page/nodeRank; no fields are re-sorted or merged across static nodes.

Semantic markers include dynamic, attachments, spatial, linked, parent, permissions, monitoring and notifications. Permission/notification markers describe the layout only: no permission assignments, recipients, histories or administrative identities are fetched or published. A dynamic `type:"label"` is a source section label; its label text remains useful even when its submission value is an empty array.

`required` and curated `options` are optional and retained only when supplied for dynamic fields. Known option data keys retain false, zero and empty values; arbitrary component configuration, listeners, CSS and JavaScript are omitted. Optional source HTML `content` is structurally sanitized and embedded media bodies removed. Source page labels are retained only for known page IDs when explicitly provided. The current 11 forms supply no page labels, required flags, choice options or static HTML content; every source page is 1. The application's General/Preview tabs belong to the original submission viewer, not inferred form-page labels.

The manifest adds `formCount`, `formNodeCount`, `formsCapturedAt`, a `files["forms.json.gz"]` byte/hash entry and explicit anonymous form-definition verification flags. Content capture time and the submission gzip/hash remain unchanged during a forms-only refresh.

The reviewed form snapshot contains **11 forms and 134 nodes**: 82 dynamic fields and 52 static resource/layout markers. It measures **26,030 decoded JSON bytes / 2,203 gzip bytes**. The corresponding submission snapshot remains 1,465 records, 18,688 field values, 7,462,208 decoded bytes and 1,174,698 gzip bytes. Manifest timestamps and hashes identify these exact artifacts; later refreshes may change their sizes.

## Content and media handling

JSON false, zero, null, empty strings and arrays retain their types and values. Rich HTML retains a restricted structural tag set and safe attributes. Scripts, active embeds, event handlers, styles and unsafe URL schemes are removed. Existing image/link references are resolved against the original portal, restricted to HTTP(S), and reject credential-bearing URLs. Remote bodies are not fetched, so remote references have no invented digest or MIME certainty (`image/unknown`).

Inline data URI media is removed from deployed field values. A placeholder and media entry retain field ID, ordinal, MIME type, source portal reference and SHA-256 of decoded bytes. Malformed encoded media falls back to a digest of its source data URI; no body is retained. There is no invented remote image URL. Reference identity is the containing submission ID plus field ID and ordinal. Repeated media digests can be recognized without republishing their bytes.

The original client opens submissions via in-page Search and `openSubmission(id)`. No canonical URL query/hash deep-link was verified, so source links deliberately point to the real portal root and the UI displays the original submission ID. Native attachment download strings are POST workflow paths, not verified GET links: they are not converted to invented file URLs. Attachment and spatial-file bodies, monitoring observations and full raw response evidence are outside this snapshot.

## Ownership

The script, tests, README, manifest and deterministic compressed snapshot belong to BCDataMapper. PGMaps copies `output` to `public/data/nechako-portal` through its data synchronization step. Do not separately commit generated deployment copies in PGMaps.
