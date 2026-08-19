#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { PMTiles, SharedPromiseCache } from 'pmtiles'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = join(SCRIPT_DIR, 'output')
const SOURCES_PATH = join(SCRIPT_DIR, 'sources.json')
const DEFAULT_BUILD_DIR = resolve(process.env.PGMAPS_ROOT ?? process.cwd(), 'build/bc-outdoors-pmtiles')
const DEFAULT_CATALOG_PATH = join(OUTPUT_DIR, 'r2', 'pmtiles-catalog.json')

function parseArgs(argv) {
  const args = {
    buildDir: DEFAULT_BUILD_DIR,
    catalogPath: DEFAULT_CATALOG_PATH,
    bucket: process.env.R2_BUCKET,
    prefix: process.env.R2_PREFIX,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    version: process.env.R2_VERSION,
    minzoom: 0,
    maxzoom: 12,
    upload: false,
    skipBuild: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--build-dir') args.buildDir = resolve(argv[++index])
    else if (token === '--catalog') args.catalogPath = resolve(argv[++index])
    else if (token === '--bucket') args.bucket = argv[++index]
    else if (token === '--prefix') args.prefix = argv[++index]
    else if (token === '--public-base-url') args.publicBaseUrl = argv[++index]
    else if (token === '--version') args.version = argv[++index]
    else if (token === '--minzoom') args.minzoom = Number(argv[++index])
    else if (token === '--maxzoom') args.maxzoom = Number(argv[++index])
    else if (token === '--upload') args.upload = true
    else if (token === '--skip-build') args.skipBuild = true
    else if (token === '--help' || token === '-h') args.help = true
    else throw new Error(`Unknown argument: ${token}`)
  }
  if (!Number.isInteger(args.minzoom) || !Number.isInteger(args.maxzoom) || args.minzoom < 0 || args.maxzoom < args.minzoom) {
    throw new Error('Zooms must be integers with 0 <= minzoom <= maxzoom')
  }
  return args
}

function printHelp() {
  console.log(`Usage: node build-bc-outdoors-pmtiles.mjs [options]

Builds, validates and optionally publishes BC outdoors PMTiles.

Options:
  --build-dir <path>       Local ignored PMTiles output
  --catalog <path>         Publication catalog output
  --bucket <name>          R2 bucket
  --prefix <path>          R2 prefix
  --version <segment>      Immutable version segment
  --public-base-url <url>  Public R2 hostname
  --minzoom <number>       Minimum tile zoom (default: 0)
  --maxzoom <number>       Maximum native tile zoom (default: 12)
  --upload                 Upload archives and catalog with Wrangler v4
  --skip-build             Validate and publish existing local archives
  --help                   Show this help`)
}

function run(command, argumentsList) {
  console.log(`+ ${[command, ...argumentsList].join(' ')}`)
  const env = command === 'tippecanoe'
    ? { ...process.env, TIPPECANOE_MAX_THREADS: '1' }
    : process.env
  const result = spawnSync(command, argumentsList, { stdio: 'inherit', env })
  if (result.error?.code === 'ENOENT') throw new Error(`${command} is required`)
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

class NodeFileSource {
  constructor(path) {
    this.path = path
  }

  getKey() {
    return this.path
  }

  async getBytes(offset, length) {
    const chunks = []
    let total = 0
    await new Promise((resolvePromise, rejectPromise) => {
      const stream = createReadStream(this.path, { start: offset, end: offset + length - 1 })
      stream.on('data', (chunk) => {
        chunks.push(chunk)
        total += chunk.length
      })
      stream.on('error', rejectPromise)
      stream.on('end', resolvePromise)
    })
    const data = Buffer.concat(chunks, total)
    return { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }
  }
}

async function inspectArchive(path, expectedLayers) {
  const archive = new PMTiles(new NodeFileSource(path), new SharedPromiseCache(32))
  const [header, metadata, info, digest] = await Promise.all([
    archive.getHeader(),
    archive.getMetadata(),
    stat(path),
    sha256(path),
  ])
  const vectorLayers = metadata.vector_layers ?? []
  const actualIds = new Set(vectorLayers.map((layer) => layer.id))
  for (const layer of expectedLayers) {
    if (!actualIds.has(layer.id)) throw new Error(`${basename(path)} is missing source layer ${layer.id}`)
  }
  if (!header.numTileEntries || !header.numTileContents) throw new Error(`${basename(path)} contains no tiles`)
  return {
    bytes: info.size,
    sha256: digest,
    minzoom: header.minZoom,
    maxzoom: header.maxZoom,
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    tileEntries: header.numTileEntries,
    tileContents: header.numTileContents,
    vectorLayers,
  }
}

function immutableVersion(manifest) {
  const dates = manifest.layers
    .map((layer) => layer.sourceLastModifiedAt)
    .filter(Boolean)
    .map((value) => value.slice(0, 10))
    .sort()
  return `v${dates.at(-1) ?? manifest.generatedAt.slice(0, 10)}`
}

function uploadObject(args, localPath, objectPath, contentType, cacheControl) {
  run('npx', [
    '--yes', 'wrangler@4', 'r2', 'object', 'put', `${args.bucket}/${objectPath}`,
    '--file', localPath,
    '--content-type', contentType,
    '--cache-control', cacheControl,
    '--remote',
  ])
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  printHelp()
  process.exit(0)
}

const [sources, manifest] = await Promise.all([
  readFile(SOURCES_PATH, 'utf8').then(JSON.parse),
  readFile(join(OUTPUT_DIR, 'manifest.json'), 'utf8').then(JSON.parse),
])
if (!manifest.complete) throw new Error('Run outdoors:sync before building PMTiles')

args.bucket ??= sources.storage.r2Bucket
args.prefix ??= sources.storage.r2Prefix
args.publicBaseUrl ??= sources.storage.publicBaseUrl
args.version ??= immutableVersion(manifest)

await mkdir(args.buildDir, { recursive: true })
await mkdir(dirname(args.catalogPath), { recursive: true })
// Tippecanoe records its input path in archive metadata. Use a stable path so
// identical source data produces an identical immutable PMTiles object.
const temporaryDirectory = join(args.buildDir, '.tippecanoe-input')
await rm(temporaryDirectory, { recursive: true, force: true })
await mkdir(temporaryDirectory, { recursive: true })

try {
  const archiveGroups = new Map()
  for (const layer of manifest.layers) {
    const group = archiveGroups.get(layer.archive) ?? []
    group.push(layer)
    archiveGroups.set(layer.archive, group)
  }

  const archives = []
  for (const [archiveId, layers] of archiveGroups) {
    const inputs = []
    for (const layer of layers) {
      const compressed = await readFile(join(OUTPUT_DIR, layer.path))
      const path = join(temporaryDirectory, `${layer.id}.geojson`)
      const collection = JSON.parse(gunzipSync(compressed).toString('utf8'))
      // Tippecanoe feature IDs are numeric. Keep the human WMU identifier in
      // `boundaryCode` and use the stable source OBJECTID for tile feature IDs.
      collection.features = collection.features.map(({ id: _id, ...feature }) => feature)
      await writeFile(path, JSON.stringify(collection))
      inputs.push({ id: layer.id, path, features: layer.featureCount })
    }

    const archivePath = join(args.buildDir, `${archiveId}.pmtiles`)
    if (!args.skipBuild) {
      run('tippecanoe', [
        '--force',
        '--quiet',
        '--output', archivePath,
        '--minimum-zoom', String(args.minzoom),
        '--maximum-zoom', String(args.maxzoom),
        '--no-feature-limit',
        '--no-tile-size-limit',
        '--use-attribute-for-id', 'sourceObjectId',
        // Keep feature ordering stable so a source revision maps to one
        // byte-identical immutable R2 object across rebuilds.
        '--preserve-input-order',
        '--name', `British Columbia outdoor planning: ${archiveId}`,
        '--description', 'Authoritative public reference layers for hunting and fishing planning.',
        '--attribution', `${sources.licence.name}; Government of British Columbia`,
        ...inputs.flatMap((layer) => ['-L', `${layer.id}:${layer.path}`]),
      ])
    }

    const inspection = await inspectArchive(archivePath, inputs)
    const r2Path = `${args.prefix}/${args.version}/${basename(archivePath)}`
    archives.push({
      id: archiveId,
      title: `British Columbia outdoor planning: ${archiveId}`,
      sourceLayers: inputs.map(({ path: _path, ...input }) => input),
      r2Path,
      publicUrl: `${args.publicBaseUrl}/${r2Path}`,
      ...inspection,
    })
  }

  const catalog = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: 'datascrapers/bc/outdoors/build-bc-outdoors-pmtiles.mjs',
    sourceManifest: {
      generatedAt: manifest.generatedAt,
      layers: manifest.layers.map(({ id, sourceLastModifiedAt, featureCount }) => ({
        id,
        sourceLastModifiedAt,
        featureCount,
      })),
    },
    storage: {
      provider: 'Cloudflare R2',
      bucket: args.bucket,
      prefix: args.prefix,
      version: args.version,
      publicBaseUrl: args.publicBaseUrl,
    },
    archives,
  }
  await writeFile(args.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)
  console.log(`Wrote ${args.catalogPath}`)

  if (args.upload) {
    for (const archive of archives) {
      uploadObject(
        args,
        join(args.buildDir, `${archive.id}.pmtiles`),
        archive.r2Path,
        'application/vnd.pmtiles',
        'public,max-age=31536000,immutable',
      )
    }
    const catalogR2Path = `${args.prefix}/catalog.json`
    uploadObject(args, args.catalogPath, catalogR2Path, 'application/json', 'public,max-age=300,must-revalidate')
    console.log(`Published ${args.publicBaseUrl}/${catalogR2Path}`)
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
