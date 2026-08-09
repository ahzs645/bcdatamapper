# BC Hazard Insights / DCRRA acquisition

This directory inventories and downloads the canonical hazard layers behind the
BC Hazard Insights Tool. It intentionally excludes old `*_Apr_26` services,
simplified display duplicates, and the 4.59 GiB shared raw asset family.

## Licensing gate

Every inventoried Feature Service is marked **Access Only** by the Province of
British Columbia. Public ArcGIS query access is not permission to reproduce or
redistribute the data. The downloader therefore writes only to the ignored
`cache/` directory and requires `--acknowledge-access-only`. The R2 uploader is
blocked unless the operator separately acknowledges that written redistribution
permission has been obtained.

The configured `maps` bucket is publicly served at `https://data.map.ahmad.sh`.
Do not upload these snapshots there under the current source terms.

## Inventory and metadata

```sh
npm run hazard-insights:list
npm run hazard-insights:sync -- --metadata-only
```

`sources.json` contains 15 canonical acquisitions: eight hazard views expand to
14 hazard layers because earthquake has six components, plus the combined
exposure-summary layer. The exposure download omits geometry on purpose; its 272
fields should be joined to PGMaps' existing reporting boundaries instead of
copying the same polygons.

## Local downloads

Small sources are below the 50 MiB ArcGIS item-size threshold:

```sh
npm run hazard-insights:sync -- --profile small --acknowledge-access-only
```

Large sources are resumable sharded gzip downloads:

```sh
npm run hazard-insights:sync -- --profile large --acknowledge-access-only
```

Validate every local shard against its manifest before using it:

```sh
npm run hazard-insights:validate
```

Select individual layers with repeated `--source <slug>` arguments. Each source
gets ArcGIS item/layer metadata, deterministic gzip shards, SHA-256 hashes, and
an incrementally written `download-manifest.json`. Re-running resumes completed
shards. Use `--force` to replace a source from scratch.

## R2 publication after permission

The uploader follows the repository's existing Cloudflare R2 convention: AWS
CLI profile `r2`, bucket `maps`, and the account S3 endpoint. It selects sources
at least 50 MiB by default and uses `aws s3 sync`, which automatically uses
multipart upload for large objects.

Preview operations without contacting R2 or writing:

```sh
npm run hazard-insights:r2 -- --dry-run
```

Only after written redistribution permission has been recorded:

```sh
npm run hazard-insights:r2 -- --acknowledge-redistribution-permission
```

Override `R2_BUCKET`, `R2_PREFIX`, `R2_ENDPOINT`, or `AWS_PROFILE` as needed. No
credentials are stored in this repository.
