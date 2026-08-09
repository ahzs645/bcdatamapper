#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const INVENTORY_PATH = join(SCRIPT_DIR, 'sources.json')

function parseArgs(argv) {
  const args = {
    sources: [],
    cacheDir: join(SCRIPT_DIR, 'cache'),
    minSizeMiB: null,
    dryRun: false,
    acknowledgeRedistributionPermission: false,
    bucket: process.env.R2_BUCKET,
    prefix: process.env.R2_PREFIX,
    endpoint: process.env.R2_ENDPOINT,
    profile: process.env.AWS_PROFILE ?? 'r2',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--source') args.sources.push(argv[++index])
    else if (value === '--cache-dir') args.cacheDir = resolve(argv[++index])
    else if (value === '--min-size-mib') args.minSizeMiB = Number(argv[++index])
    else if (value === '--bucket') args.bucket = argv[++index]
    else if (value === '--prefix') args.prefix = argv[++index]
    else if (value === '--endpoint') args.endpoint = argv[++index]
    else if (value === '--profile') args.profile = argv[++index]
    else if (value === '--dry-run') args.dryRun = true
    else if (value === '--acknowledge-redistribution-permission') args.acknowledgeRedistributionPermission = true
    else if (value === '--help' || value === '-h') args.help = true
    else throw new Error(`Unknown argument: ${value}`)
  }
  return args
}

function printHelp() {
  console.log(`Usage: node upload-hazard-insights-r2.mjs [options]

Uploads completed local download shards to Cloudflare R2 using the repository's
existing AWS CLI convention. By default, only sources at least 50 MiB in the
ArcGIS inventory are selected.

Options:
  --source <slug>                           Select a source; repeat as needed
  --cache-dir <path>                        Local download cache
  --min-size-mib <number>                   Override the large-source threshold
  --bucket <name>                           R2 bucket (default: sources.json)
  --prefix <path>                           R2 key prefix (default: sources.json)
  --endpoint <url>                          R2 S3 endpoint
  --profile <name>                          AWS CLI profile (default: r2)
  --dry-run                                 Print AWS operations without writing
  --acknowledge-redistribution-permission   Required for a real upload
  --help                                    Show this help

The current destination is public. Do not use the acknowledgement flag until
written Province of British Columbia redistribution permission is on file.`)
}

function runAws(argumentsList, dryRun) {
  const display = ['aws', ...argumentsList]
  console.log(`+ ${display.join(' ')}`)
  if (dryRun) return
  const result = spawnSync('aws', display.slice(1), { stdio: 'inherit' })
  if (result.error?.code === 'ENOENT') throw new Error('aws CLI is required')
  if (result.status !== 0) throw new Error(`aws exited with status ${result.status}`)
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  printHelp()
  process.exit(0)
}
const inventory = JSON.parse(await readFile(INVENTORY_PATH, 'utf8'))
args.bucket ??= inventory.storage.r2Bucket
args.prefix ??= inventory.storage.r2Prefix
args.endpoint ??= 'https://479e77f49d4ac5d7498529ee360f194b.r2.cloudflarestorage.com'
args.minSizeMiB ??= inventory.storage.largeThresholdBytes / 1024 / 1024

if (!args.dryRun && !args.acknowledgeRedistributionPermission) {
  throw new Error('R2 upload blocked: pass --acknowledge-redistribution-permission only after written permission is on file.')
}

const requested = new Set(args.sources)
const known = new Set(inventory.sources.map((source) => source.slug))
for (const slug of requested) {
  if (!known.has(slug)) throw new Error(`Unknown source: ${slug}`)
}
const minimumBytes = args.minSizeMiB * 1024 * 1024
const sources = inventory.sources.filter((source) => requested.size
  ? requested.has(source.slug)
  : source.itemSizeBytes >= minimumBytes)

for (const source of sources) {
  const sourceDir = join(args.cacheDir, source.slug)
  const manifestPath = join(sourceDir, 'download-manifest.json')
  await access(manifestPath)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!manifest.complete || manifest.downloadedFeatureCount !== manifest.liveFeatureCount) {
    throw new Error(`${source.slug}: local download is incomplete`)
  }
  for (const shard of manifest.shards) {
    const path = join(sourceDir, shard.file)
    const info = await stat(path)
    if (info.size !== shard.bytes || await sha256(path) !== shard.sha256) {
      throw new Error(`${source.slug}: local shard failed validation: ${shard.file}`)
    }
  }

  const destination = `s3://${args.bucket}/${args.prefix}/${source.slug}`
  const common = ['--profile', args.profile, '--endpoint-url', args.endpoint]
  runAws([
    's3', 'sync', sourceDir, destination,
    ...common,
    '--exclude', 'download-manifest.json',
    '--cache-control', 'public,max-age=31536000,immutable',
  ], args.dryRun)
  runAws([
    's3', 'cp', manifestPath, `${destination}/download-manifest.json`,
    ...common,
    '--content-type', 'application/json',
    '--cache-control', 'public,max-age=300,must-revalidate',
  ], args.dryRun)
}
