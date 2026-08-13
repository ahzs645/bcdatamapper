#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { PMTiles, SharedPromiseCache } from 'pmtiles'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUTPUT_ROOT = join(SCRIPT_DIR, 'output')
const DEFAULT_BUILD_DIR = resolve(process.env.PGMAPS_ROOT ?? process.cwd(), 'build/canada-admin-pmtiles')
const DEFAULT_CATALOG_PATH = join(OUTPUT_ROOT, 'r2', 'pmtiles-catalog.json')
const DEFAULT_BUCKET = 'maps'
const DEFAULT_PREFIX = 'canada/admin-geographies'
const DEFAULT_VERSION = 'v2025-01-01'
const DEFAULT_PUBLIC_BASE_URL = 'https://data.map.ahmad.sh'

const ARCHIVES = [
  {
    id: 'census-subdivisions-2025',
    title: 'Canada census subdivisions, 2025',
    description: 'Municipalities and statistical municipal equivalents from Statistics Canada, boundaries in effect January 1, 2025.',
    referenceDate: '2025-01-01',
    representationRole: 'municipality-or-statistical-equivalent',
    licence: 'Statistics Canada Open Licence',
    sourceUrl: 'https://geo.statcan.gc.ca/geo_wa/rest/services/2025/lcsd000a25s_e/MapServer/0',
    layers: [
      { id: 'census_subdivisions_2025', path: join(OUTPUT_ROOT, 'overview', 'census-subdivisions-2025.geojson') },
    ],
  },
  {
    id: 'census-divisions-2025-derived',
    title: 'Canada census-division parent geographies, 2025 derived',
    description: 'Current regional-government or statistical-equivalent parent geographies dissolved from 2025 census subdivisions.',
    referenceDate: '2025-01-01',
    representationRole: 'regional-government-or-statistical-equivalent',
    licence: 'Statistics Canada Open Licence',
    sourceUrl: 'https://geo.statcan.gc.ca/geo_wa/rest/services/2025/lcsd000a25s_e/MapServer/0',
    layers: [
      { id: 'census_divisions_2025', path: join(OUTPUT_ROOT, 'overview', 'census-divisions-2025-derived.geojson') },
    ],
  },
  {
    id: 'census-divisions-2021',
    title: 'Canada census divisions, 2021',
    description: 'Regional governments and statistical equivalents from the 2021 Census comparison geography.',
    referenceDate: '2021-01-01',
    representationRole: 'regional-government-or-statistical-equivalent',
    licence: 'Open Government Licence - Canada',
    sourceUrl: 'https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer/4',
    layers: [
      { id: 'census_divisions_2021', path: join(OUTPUT_ROOT, 'overview', 'census-divisions-2021.geojson') },
    ],
  },
  {
    id: 'indigenous-lands-clss',
    title: 'Canada Indigenous lands by CLSS legal class',
    description: 'Canada Lands Survey System administrative boundaries retaining each federal legal distribution type.',
    referenceDate: null,
    representationRole: 'indigenous-land-by-legal-class',
    licence: 'Open Government Licence - Canada',
    sourceUrl: 'https://proxyinternet.nrcan.gc.ca/arcgis/rest/services/CLSS-SATC/CLSS_Administrative_Boundaries/MapServer/0',
    layers: [
      { id: 'indigenous_lands_clss', path: join(OUTPUT_ROOT, 'overview', 'indigenous-lands-clss.geojson') },
    ],
  },
  {
    id: 'newfoundland-labrador-overlays',
    title: 'Newfoundland and Labrador local-government and Inuit land overlays',
    description: 'Provincial municipality, Labrador Inuit Lands, and Labrador Inuit Settlement Area source layers.',
    referenceDate: null,
    representationRole: 'provincial-local-government-and-treaty-land-overlays',
    licence: 'Government of Newfoundland and Labrador open-data terms',
    sourceUrl: 'https://dnrmaps.gov.nl.ca/arcgis/rest/services/GeoAtlas/Land_Use/MapServer',
    layers: [
      { id: 'nl_municipalities', path: join(OUTPUT_ROOT, 'provincial', 'newfoundland-labrador', 'municipalities.geojson.gz') },
      { id: 'nl_labrador_inuit_lands', path: join(OUTPUT_ROOT, 'provincial', 'newfoundland-labrador', 'labradorInuitLands.geojson.gz') },
      { id: 'nl_labrador_inuit_settlement_area', path: join(OUTPUT_ROOT, 'provincial', 'newfoundland-labrador', 'labradorInuitSettlementArea.geojson.gz') },
    ],
  },
]

function parseArgs(argv) {
  const args = {
    buildDir: DEFAULT_BUILD_DIR,
    catalogPath: DEFAULT_CATALOG_PATH,
    bucket: process.env.R2_BUCKET ?? DEFAULT_BUCKET,
    prefix: process.env.R2_PREFIX ?? DEFAULT_PREFIX,
    version: process.env.R2_VERSION ?? DEFAULT_VERSION,
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL,
    minzoom: 0,
    maxzoom: 9,
    upload: false,
    skipBuild: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--build-dir') args.buildDir = resolve(argv[++index])
    else if (token === '--catalog') args.catalogPath = resolve(argv[++index])
    else if (token === '--bucket') args.bucket = argv[++index]
    else if (token === '--prefix') args.prefix = argv[++index]
    else if (token === '--version') args.version = argv[++index]
    else if (token === '--public-base-url') args.publicBaseUrl = argv[++index]
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
  console.log(`Usage: node build-pmtiles.mjs [options]

Builds and validates the Canada administrative-geography PMTiles catalog.

Options:
  --build-dir <path>       Local PMTiles output (default: build/canada-admin-pmtiles)
  --catalog <path>         Publication catalog written into scraper output
  --minzoom <number>       Minimum tile zoom (default: 0)
  --maxzoom <number>       Maximum native tile zoom (default: 9; clients can overzoom)
  --bucket <name>          Cloudflare R2 bucket (default: maps)
  --prefix <path>          R2 key prefix (default: canada/admin-geographies)
  --version <path>         Immutable R2 version segment (default: v2025-01-01)
  --public-base-url <url>  Public R2 hostname (default: https://data.map.ahmad.sh)
  --upload                 Upload PMTiles and catalog using Wrangler v4 remote mode
  --skip-build             Validate and publish already-built local archives
  --help                   Show this help`)
}

function run(command, argumentsList) {
  console.log(`+ ${[command, ...argumentsList].join(' ')}`)
  const result = spawnSync(command, argumentsList, { stdio: 'inherit' })
  if (result.error?.code === 'ENOENT') throw new Error(`${command} is required`)
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}

async function readFeatureCollection(path) {
  const contents = await readFile(path)
  const decoded = path.endsWith('.gz') ? gunzipSync(contents) : contents
  const collection = JSON.parse(decoded.toString('utf8'))
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error(`Expected GeoJSON FeatureCollection: ${path}`)
  }
  return collection
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

async function inspectArchive(path, expectedLayerIds) {
  const archive = new PMTiles(new NodeFileSource(path), new SharedPromiseCache(32))
  const [header, metadata, info, digest] = await Promise.all([
    archive.getHeader(),
    archive.getMetadata(),
    stat(path),
    sha256(path),
  ])
  const vectorLayers = metadata.vector_layers ?? []
  const actualLayerIds = new Set(vectorLayers.map((layer) => layer.id))
  for (const layerId of expectedLayerIds) {
    if (!actualLayerIds.has(layerId)) throw new Error(`${basename(path)} is missing source layer ${layerId}`)
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

async function materializeLayerInputs(archive, temporaryDirectory) {
  const inputs = []
  for (const layer of archive.layers) {
    const collection = await readFeatureCollection(layer.path)
    const path = join(temporaryDirectory, `${layer.id}.geojson`)
    await writeFile(path, JSON.stringify(collection))
    inputs.push({ id: layer.id, path, features: collection.features.length })
  }
  return inputs
}

async function buildArchive(archive, args, temporaryDirectory) {
  const inputs = await materializeLayerInputs(archive, temporaryDirectory)
  const path = join(args.buildDir, `${archive.id}.pmtiles`)
  if (!args.skipBuild) {
    run('tippecanoe', [
      '--force',
      '--quiet',
      '--output', path,
      '--minimum-zoom', String(args.minzoom),
      '--maximum-zoom', String(args.maxzoom),
      '--no-feature-limit',
      '--no-tile-size-limit',
      '--read-parallel',
      '--name', archive.title,
      '--description', archive.description,
      '--attribution', `${archive.licence}; ${archive.sourceUrl}`,
      ...inputs.flatMap((layer) => ['-L', `${layer.id}:${layer.path}`]),
    ])
  }
  const inspection = await inspectArchive(path, inputs.map((layer) => layer.id))
  const versionedPath = `${args.prefix.replace(/^\/+|\/+$/g, '')}/${args.version.replace(/^\/+|\/+$/g, '')}/${basename(path)}`
  return {
    id: archive.id,
    title: archive.title,
    description: archive.description,
    referenceDate: archive.referenceDate,
    representationRole: archive.representationRole,
    sourceUrl: archive.sourceUrl,
    licence: archive.licence,
    sourceLayers: inputs.map((layer) => ({ id: layer.id, features: layer.features })),
    localPath: path,
    r2Path: versionedPath,
    publicUrl: `${args.publicBaseUrl.replace(/\/$/, '')}/${versionedPath}`,
    ...inspection,
  }
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

await mkdir(args.buildDir, { recursive: true })
await mkdir(dirname(args.catalogPath), { recursive: true })
const temporaryDirectory = join(tmpdir(), `bcdatamapper-canada-admin-${process.pid}`)
await mkdir(temporaryDirectory, { recursive: true })

try {
  const sourceManifestPath = join(OUTPUT_ROOT, 'manifest.json')
  const sourceManifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'))
  if (!sourceManifest.complete) throw new Error('Canada administrative-geographies source manifest is incomplete')

  const archives = []
  for (const archive of ARCHIVES) {
    console.log(`[${archives.length + 1}/${ARCHIVES.length}] ${archive.title}`)
    archives.push(await buildArchive(archive, args, temporaryDirectory))
  }

  const catalog = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: 'datascrapers/canada/admin-geographies/build-pmtiles.mjs',
    sourceManifest: {
      path: 'manifest.json',
      generatedAt: sourceManifest.generatedAt,
      sha256: await sha256(sourceManifestPath),
    },
    storage: {
      provider: 'Cloudflare R2',
      bucket: args.bucket,
      prefix: args.prefix,
      version: args.version,
      publicBaseUrl: args.publicBaseUrl,
    },
    archives: archives.map(({ localPath: _localPath, ...archive }) => archive),
  }
  await writeFile(args.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)
  console.log(`Wrote ${args.catalogPath}`)

  if (args.upload) {
    for (const archive of archives) {
      uploadObject(args, archive.localPath, archive.r2Path, 'application/vnd.pmtiles', 'public,max-age=31536000,immutable')
    }
    const catalogPath = `${args.prefix.replace(/^\/+|\/+$/g, '')}/catalog.json`
    uploadObject(args, args.catalogPath, catalogPath, 'application/json', 'public,max-age=300,must-revalidate')
    console.log(`Published ${args.publicBaseUrl.replace(/\/$/, '')}/${catalogPath}`)
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
