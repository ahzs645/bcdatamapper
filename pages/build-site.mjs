// Assemble the Pages site: every mapping in pages/site.json copied below
// <out>/data/, a data/version.json recording the commit and each folder's
// fingerprint, and a landing page. Usage: node pages/build-site.mjs [--out _site]
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { folderFingerprints, readSite, siteFiles } from './site.mjs'

// GitHub Pages refuses sites over 1 GB. Stop before a deploy would fail and
// leave room for growth that someone has to decide about.
const LIMIT_BYTES = 1_000_000_000
const WARN_BYTES = 800_000_000

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outIndex = process.argv.indexOf('--out')
const out = resolve(outIndex > 0 ? process.argv[outIndex + 1] : join(root, '_site'))

const site = readSite(root)

// A push only republishes when the workflow's path filter sees the change, so
// every mapped source must be listed there.
const workflow = readFileSync(join(root, '.github', 'workflows', 'pages.yml'), 'utf8')
const unwatched = site.mappings
  .map(([source]) => source)
  .filter((source) => !workflow.includes(`'${source}/**'`) && !workflow.includes(`'${source}'`))
if (unwatched.length > 0) {
  throw new Error(`.github/workflows/pages.yml does not watch: ${unwatched.join(', ')}`)
}

rmSync(out, { recursive: true, force: true })
const files = siteFiles(root, site)
for (const [source, published] of files) {
  const destination = join(out, 'data', published)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
}

const folders = folderFingerprints(root, site)
const bytes = Object.values(folders).reduce((sum, folder) => sum + folder.bytes, 0)
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
writeFileSync(join(out, 'data', 'version.json'), `${JSON.stringify({ schemaVersion: 1, commit, folders }, null, 2)}\n`)

const rows = Object.entries(folders)
  .map(
    ([folder, { files: count, bytes: size }]) =>
      `<li><code>data/${folder}/</code>: ${count} files, ${(size / 1e6).toFixed(1)} MB</li>`,
  )
  .join('\n')
writeFileSync(
  join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>bcdatamapper data</title>
<p>Scraper snapshots from <a href="https://github.com/ahzs645/bcdatamapper">bcdatamapper</a>, served for
<a href="https://pgmaps.ahmadjalil.com/">PGMaps</a>. Commit <code>${commit.slice(0, 12)}</code>;
<a href="data/version.json">version.json</a> lists each folder's fingerprint.</p>
<ul>
${rows}
</ul>
`,
)

console.log(
  `[pages] ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB in ${Object.keys(folders).length} folders -> ${out}`,
)
for (const [folder, { files: count, bytes: size }] of Object.entries(folders)) {
  console.log(`[pages]   ${folder}: ${count} files, ${(size / 1e6).toFixed(1)} MB`)
}
if (bytes > LIMIT_BYTES) {
  console.error(`[pages] ${(bytes / 1e6).toFixed(0)} MB is over GitHub Pages' 1 GB site limit`)
  process.exit(1)
}
if (bytes > WARN_BYTES) {
  const message = `The Pages site is ${(bytes / 1e6).toFixed(0)} MB of a 1 GB limit`
  console.log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `[pages] ${message}`)
}
