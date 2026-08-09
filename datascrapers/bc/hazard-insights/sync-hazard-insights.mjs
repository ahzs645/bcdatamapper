#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const INVENTORY_PATH = join(SCRIPT_DIR, 'sources.json')
const DEFAULT_OUTPUT_DIR = join(SCRIPT_DIR, 'cache')
const USER_AGENT = 'bcdatamapper-hazard-insights/1.0'

function parseArgs(argv) {
  const args = {
    sources: [],
    profile: 'all',
    outputDir: DEFAULT_OUTPUT_DIR,
    pageSize: 1000,
    pageSizeExplicit: false,
    concurrency: 4,
    metadataOnly: false,
    acknowledgeAccessOnly: false,
    force: false,
    list: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--source') args.sources.push(argv[++index])
    else if (value === '--profile') args.profile = argv[++index]
    else if (value === '--output-dir') args.outputDir = resolve(argv[++index])
    else if (value === '--page-size') {
      args.pageSize = Number(argv[++index])
      args.pageSizeExplicit = true
    }
    else if (value === '--concurrency') args.concurrency = Number(argv[++index])
    else if (value === '--metadata-only') args.metadataOnly = true
    else if (value === '--acknowledge-access-only') args.acknowledgeAccessOnly = true
    else if (value === '--force') args.force = true
    else if (value === '--list') args.list = true
    else if (value === '--help' || value === '-h') args.help = true
    else throw new Error(`Unknown argument: ${value}`)
  }
  if (!['all', 'small', 'large'].includes(args.profile)) {
    throw new Error('--profile must be one of: all, small, large')
  }
  if (!Number.isInteger(args.pageSize) || args.pageSize < 1 || args.pageSize > 2000) {
    throw new Error('--page-size must be an integer from 1 to 2000')
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 8) {
    throw new Error('--concurrency must be an integer from 1 to 8')
  }
  return args
}

function printHelp() {
  console.log(`Usage: node sync-hazard-insights.mjs [options]

Options:
  --list                         List canonical sources and exit
  --source <slug>                Download one source; repeat as needed
  --profile <all|small|large>    Select by the 50 MiB inventory threshold
  --output-dir <path>            Override the ignored local cache directory
  --page-size <1-2000>           ArcGIS object-id batch size (default: 1000)
  --concurrency <1-8>            Concurrent record batches (default: 4)
  --metadata-only                Refresh metadata without downloading records
  --acknowledge-access-only      Required for local record downloads
  --force                        Replace existing shards instead of resuming
  --help                         Show this help

The source datasets are licensed "Access Only". Local record downloads are for
authorized research use and remain ignored by git. This script does not upload.`)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function apiUrl(base, parameters = {}) {
  const url = new URL(base)
  for (const [key, value] of Object.entries({ f: 'json', ...parameters })) {
    url.searchParams.set(key, String(value))
  }
  return url
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
}

async function fetchJson(url, options = {}, attempts = 5) {
  const { timeoutMs = 120_000, ...requestOptions } = options
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...requestOptions,
        headers: { 'user-agent': USER_AGENT, ...requestOptions.headers },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
      const payload = await response.json()
      if (payload.error) {
        throw new Error(`ArcGIS ${payload.error.code}: ${payload.error.message}`)
      }
      return payload
    } catch (error) {
      lastError = error
      if (attempt < attempts) await wait(1000 * 2 ** (attempt - 1))
    }
  }
  throw lastError
}

function postFormJson(url, parameters, { attempts = 5, timeoutMs = 120_000 } = {}) {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries({ f: 'json', ...parameters })) {
    if (value != null) body.set(key, String(value))
  }
  return fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    timeoutMs,
  }, attempts)
}

async function writeJsonAtomic(path, payload) {
  const partialPath = `${path}.part`
  await writeFile(partialPath, `${JSON.stringify(payload, null, 2)}\n`)
  await rename(partialPath, path)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function selectSources(inventory, args) {
  const requested = new Set(args.sources)
  const known = new Set(inventory.sources.map((source) => source.slug))
  for (const slug of requested) {
    if (!known.has(slug)) throw new Error(`Unknown source: ${slug}`)
  }
  return inventory.sources.filter((source) => {
    if (requested.size) return requested.has(source.slug)
    const large = source.itemSizeBytes >= inventory.storage.largeThresholdBytes
    return args.profile === 'all' || (args.profile === 'large' ? large : !large)
  })
}

function listSources(inventory) {
  for (const source of inventory.sources) {
    const sizeMiB = (source.itemSizeBytes / 1024 / 1024).toFixed(1)
    const storage = source.itemSizeBytes >= inventory.storage.largeThresholdBytes
      ? 'R2 after permission'
      : 'local cache'
    console.log(`${source.slug.padEnd(38)} ${String(source.expectedFeatureCount).padStart(8)} features  ${sizeMiB.padStart(8)} MiB  ${storage}`)
  }
}

async function queryFeatureIds(layerUrl, layer, expectedCount) {
  const payload = await fetchJson(apiUrl(`${layerUrl}/query`, {
    where: '1=1',
    returnIdsOnly: 'true',
    returnGeometry: 'false',
  }))
  const directIds = [...(payload.objectIds ?? [])].sort((left, right) => left - right)
  if (directIds.length === expectedCount) return directIds

  if (!layer.advancedQueryCapabilities?.supportsPagination) {
    throw new Error(`ArcGIS truncated returnIdsOnly at ${directIds.length} and the layer does not support pagination`)
  }
  const objectIdField = layer.objectIdField
    ?? layer.fields?.find((field) => field.type === 'esriFieldTypeOID')?.name
  if (!objectIdField) throw new Error('Layer metadata does not identify an object-id field')

  const statistics = JSON.stringify([
    { statisticType: 'min', onStatisticField: objectIdField, outStatisticFieldName: 'min_oid' },
    { statisticType: 'max', onStatisticField: objectIdField, outStatisticFieldName: 'max_oid' },
  ])
  const boundsPayload = await postFormJson(`${layerUrl}/query`, {
    where: '1=1',
    outStatistics: statistics,
    returnGeometry: 'false',
    f: 'json',
  })
  const bounds = boundsPayload.features?.[0]?.attributes
  if (!Number.isFinite(bounds?.min_oid) || !Number.isFinite(bounds?.max_oid)) {
    throw new Error('ArcGIS did not return object-id bounds')
  }

  async function queryRange(minimum, maximum, knownCount) {
    if (!knownCount) return []
    const where = `${objectIdField} >= ${minimum} AND ${objectIdField} <= ${maximum}`
    const idsPayload = await fetchJson(apiUrl(`${layerUrl}/query`, {
      where,
      returnIdsOnly: 'true',
      returnGeometry: 'false',
    }))
    const ids = idsPayload.objectIds ?? []
    if (ids.length === knownCount) return ids
    if (minimum >= maximum) {
      throw new Error(`ArcGIS truncated object IDs for indivisible range ${minimum}-${maximum}`)
    }

    const middle = Math.floor((minimum + maximum) / 2)
    const leftWhere = `${objectIdField} >= ${minimum} AND ${objectIdField} <= ${middle}`
    const leftCountPayload = await fetchJson(apiUrl(`${layerUrl}/query`, {
      where: leftWhere,
      returnCountOnly: 'true',
      returnGeometry: 'false',
    }))
    const leftCount = leftCountPayload.count
    const [left, right] = await Promise.all([
      queryRange(minimum, middle, leftCount),
      queryRange(middle + 1, maximum, knownCount - leftCount),
    ])
    return [...left, ...right]
  }

  console.log(`  returnIdsOnly was capped at ${directIds.length.toLocaleString()}; splitting the ${objectIdField} range`)
  const ids = await queryRange(bounds.min_oid, bounds.max_oid, expectedCount)
  ids.sort((left, right) => left - right)
  const uniqueIds = new Set(ids)
  if (ids.length !== expectedCount || uniqueIds.size !== expectedCount) {
    throw new Error(`Paginated object-id count ${ids.length} (${uniqueIds.size} unique) does not match ${expectedCount}`)
  }
  return ids
}

async function fetchBatch(layerUrl, source, objectIds) {
  const batchCapApplies = source.queryBatchSize
    && objectIds.length > source.queryBatchSize
    && (!source.queryBatchSizeFromObjectId || objectIds[0] >= source.queryBatchSizeFromObjectId)
  if (batchCapApplies) {
    const features = []
    for (let offset = 0; offset < objectIds.length; offset += source.queryBatchSize) {
      features.push(...await fetchBatch(layerUrl, source, objectIds.slice(offset, offset + source.queryBatchSize)))
    }
    return features
  }
  const geometry = source.downloadMode === 'geometry'
  const parameters = {
    objectIds: objectIds.join(','),
    outFields: '*',
    returnGeometry: geometry ? 'true' : 'false',
    outSR: geometry ? '4326' : null,
    f: geometry ? 'geojson' : 'json',
  }
  let payload
  try {
    payload = await postFormJson(`${layerUrl}/query`, parameters, { attempts: 1, timeoutMs: 20_000 })
  } catch (error) {
    if (objectIds.length === 1) {
      console.warn(`\n  ${source.slug}: retrying dense object ${objectIds[0]} with a 180-second timeout`)
      payload = await postFormJson(`${layerUrl}/query`, parameters, { attempts: 1, timeoutMs: 180_000 })
    } else {
      const middle = Math.ceil(objectIds.length / 2)
      const left = await fetchBatch(layerUrl, source, objectIds.slice(0, middle))
      const right = await fetchBatch(layerUrl, source, objectIds.slice(middle))
      return [...left, ...right]
    }
  }
  const features = payload.features ?? []
  if (features.length === objectIds.length) return features
  if (objectIds.length === 1) {
    throw new Error(`ArcGIS returned ${features.length} records for object id ${objectIds[0]}`)
  }
  const middle = Math.ceil(objectIds.length / 2)
  const left = await fetchBatch(layerUrl, source, objectIds.slice(0, middle))
  const right = await fetchBatch(layerUrl, source, objectIds.slice(middle))
  return [...left, ...right]
}

function shardPayload(source, features) {
  if (source.downloadMode === 'geometry') {
    return { type: 'FeatureCollection', features }
  }
  return {
    objectIdFieldName: null,
    geometryType: null,
    features,
  }
}

async function existingManifest(path) {
  try {
    return await readJson(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function syncSource(inventory, source, args) {
  const sourceDir = join(args.outputDir, source.slug)
  const shardsDir = join(sourceDir, 'shards')
  const manifestPath = join(sourceDir, 'download-manifest.json')
  if (args.force) await rm(sourceDir, { recursive: true, force: true })
  await mkdir(shardsDir, { recursive: true })

  const itemUrl = apiUrl(`https://www.arcgis.com/sharing/rest/content/items/${source.itemId}`)
  const layerUrl = `${source.serviceUrl}/${source.layerId}`
  const [item, layer] = await Promise.all([
    fetchJson(itemUrl),
    fetchJson(apiUrl(layerUrl)),
  ])
  await writeJsonAtomic(join(sourceDir, 'item-metadata.json'), item)
  await writeJsonAtomic(join(sourceDir, 'layer-metadata.json'), layer)

  const liveCountPayload = await fetchJson(apiUrl(`${layerUrl}/query`, {
    where: '1=1',
    returnCountOnly: 'true',
    returnGeometry: 'false',
  }))
  const liveFeatureCount = liveCountPayload.count
  console.log(`${source.slug}: ${liveFeatureCount.toLocaleString()} records`)

  if (args.metadataOnly) return

  const objectIds = await queryFeatureIds(layerUrl, layer, liveFeatureCount)
  if (objectIds.length !== liveFeatureCount) {
    throw new Error(`${source.slug}: id count ${objectIds.length} does not match live count ${liveFeatureCount}`)
  }

  const previous = await existingManifest(manifestPath)
  const pageSize = previous?.pageSize && !args.pageSizeExplicit ? previous.pageSize : args.pageSize
  if (previous?.pageSize && previous.pageSize !== pageSize) {
    throw new Error(`${source.slug}: existing page size is ${previous.pageSize}; use --page-size ${previous.pageSize} or --force`)
  }
  const previousShards = new Map((previous?.shards ?? []).map((shard) => [shard.file, shard]))
  const shards = []
  let compressedBytes = 0
  let downloadedFeatures = 0

  async function acquireShard(offset) {
    const batch = objectIds.slice(offset, offset + pageSize)
    const part = Math.floor(offset / pageSize) + 1
    const file = `shards/part-${String(part).padStart(5, '0')}.json.gz`
    const path = join(sourceDir, file)
    const prior = previousShards.get(file)
    let shard

    try {
      const info = await stat(path)
      if (!prior || prior.bytes !== info.size || prior.firstObjectId !== batch[0] || prior.lastObjectId !== batch.at(-1)) {
        throw new Error('existing shard does not match current batch')
      }
      shard = prior
    } catch (error) {
      if (error.code !== 'ENOENT' && error.message !== 'existing shard does not match current batch') throw error
      const features = await fetchBatch(layerUrl, source, batch)
      const uncompressed = Buffer.from(`${JSON.stringify(shardPayload(source, features))}\n`)
      const compressed = gzipSync(uncompressed, { level: 9, mtime: 0 })
      const partialPath = `${path}.part`
      await writeFile(partialPath, compressed)
      await rename(partialPath, path)
      shard = {
        file,
        featureCount: features.length,
        firstObjectId: batch[0],
        lastObjectId: batch.at(-1),
        bytes: compressed.length,
        uncompressedBytes: uncompressed.length,
        sha256: sha256(compressed),
      }
    }

    return shard
  }

  const waveSize = pageSize * args.concurrency
  for (let waveOffset = 0; waveOffset < objectIds.length; waveOffset += waveSize) {
    const offsets = []
    for (let offset = waveOffset; offset < Math.min(waveOffset + waveSize, objectIds.length); offset += pageSize) {
      offsets.push(offset)
    }
    const wave = await Promise.all(offsets.map(acquireShard))
    for (const shard of wave) {
      shards.push(shard)
      compressedBytes += shard.bytes
      downloadedFeatures += shard.featureCount
    }
    const manifest = {
      schemaVersion: 1,
      source: { ...source },
      license: inventory.license,
      generatedAt: new Date().toISOString(),
      layerUrl,
      pageSize,
      liveFeatureCount,
      downloadedFeatureCount: downloadedFeatures,
      complete: downloadedFeatures === liveFeatureCount,
      format: source.downloadMode === 'geometry'
        ? 'sharded GeoJSON FeatureCollections, gzip compressed'
        : 'sharded ArcGIS JSON attribute records, gzip compressed; geometry omitted',
      compressedBytes,
      shards,
    }
    await writeJsonAtomic(manifestPath, manifest)
    process.stdout.write(`\r  ${downloadedFeatures.toLocaleString()}/${liveFeatureCount.toLocaleString()} records, ${(compressedBytes / 1024 / 1024).toFixed(1)} MiB compressed`)
  }
  process.stdout.write('\n')

  const expectedShardNames = new Set(shards.map((shard) => shard.file.split('/').at(-1)))
  for (const entry of await readdir(shardsDir)) {
    if (/^part-\d+\.json\.gz(?:\.part)?$/.test(entry) && !expectedShardNames.has(entry)) {
      await rm(join(shardsDir, entry))
    }
  }
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  printHelp()
  process.exit(0)
}

const inventory = await readJson(INVENTORY_PATH)
if (args.list) {
  listSources(inventory)
  process.exit(0)
}

if (!args.metadataOnly && !args.acknowledgeAccessOnly) {
  throw new Error('Record downloads require --acknowledge-access-only. See sources.json and README.md.')
}

const sources = selectSources(inventory, args)
await mkdir(args.outputDir, { recursive: true })
for (const source of sources) await syncSource(inventory, source, args)
