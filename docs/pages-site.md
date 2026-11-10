# Pages data site

`.github/workflows/pages.yml` publishes the folders in `pages/site.json` at
`https://projects.ahmadjalil.com/bcdatamapper/data/<folder>/`, with the same
layout they have in PGMaps' `public/data`. PGMaps lists the same folders in its
`src/config/data-hosts.json`, loads them from here, and leaves them out of its
own Pages build, so a data change here reaches the live app without a PGMaps
deploy.

## What is published

`pages/site.json` has two lists:

- `folders`: the top-level folders this site serves. PGMaps' data-hosts entry
  must list the same names.
- `mappings`: `[source in this repo, path below /data]` pairs that fill them.

Only committed snapshot output belongs here. Do not publish anything with
access conditions (the early-learning boundary caches, for example), and keep a
folder whole: PGMaps sends every request under a listed folder to this site.

`pages/build-site.mjs` copies the mappings into `_site/data/`, writes
`_site/data/version.json` and a landing page, and refuses to build when:

- a source is missing or a target falls outside the listed folders;
- a mapped source is not in the workflow's `paths` filter, because a push to it
  would then not republish;
- the site exceeds GitHub Pages' 1 GB limit. It warns above 800 MB.

Run it locally with `node pages/build-site.mjs --out /tmp/site`; it needs only
Node.

## Versions

Pages serves one version at a time: whatever the last publish built.

- A push to `main` that touches a mapped source publishes it straight away.
- To roll back, or to publish an exact commit, run **Publish data site** by hand
  with that commit as `ref`.
- `data/version.json` records the commit and, per folder, a SHA-256 fingerprint
  over every published path and file hash. `pages/site.mjs` computes it, and
  PGMaps imports the same module: its deploy compares the live fingerprints with
  the ones its pinned submodule commit gives, and warns when they differ.

PGMaps' submodule pointer therefore no longer pins these folders on the live
site; it records the data PGMaps was last checked against.

## Adding or moving a folder

1. Add its mappings and folder name to `pages/site.json`, and each source to the
   workflow's `paths`.
2. Merge; the push publishes it. Check
   `https://projects.ahmadjalil.com/bcdatamapper/data/version.json`.
3. In PGMaps, move the submodule pointer and add the folder to the
   `bcdatamapper` host in `src/config/data-hosts.json`. PGMaps' sync reads these
   mappings from `pages/site.json`, so remove any copy of them from
   `scripts/sync-bcdatamapper-data.mjs`.
