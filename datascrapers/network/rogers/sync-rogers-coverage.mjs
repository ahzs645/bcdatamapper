import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output')
const TILE_DIR = path.join(OUTPUT_DIR, 'tiles')
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')

const ROGERS_COVERAGE_URL = 'https://www.rogers.com/mobility/network-coverage-map'
const DEFAULT_LAYER_IDS = ['4g5g', '4g', '3g', 'ltem', 'nbiot', 'comp_sat']
const DEFAULT_BOUNDS = {
  west: -142,
  south: 41,
  east: -52,
  north: 84,
}

function parseArgs(argv) {
  const args = {
    minZoom: 3,
    maxZoom: 8,
    layers: DEFAULT_LAYER_IDS,
    bounds: DEFAULT_BOUNDS,
    force: false,
    concurrency: 8,
    delayMs: 0,
    retries: 2,
    retryDelayMs: 2_000,
    minAlpha: 16,
    saveEmpty: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--force') args.force = true
    else if (arg === '--save-empty') args.saveEmpty = true
    else if (arg === '--min-zoom') args.minZoom = Number(argv[++i])
    else if (arg === '--max-zoom') args.maxZoom = Number(argv[++i])
    else if (arg === '--layers') args.layers = argv[++i].split(',').map((value) => value.trim()).filter(Boolean)
    else if (arg === '--bounds') args.bounds = parseBounds(argv[++i])
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i])
    else if (arg === '--delay-ms') args.delayMs = Number(argv[++i])
    else if (arg === '--retries') args.retries = Number(argv[++i])
    else if (arg === '--retry-delay-ms') args.retryDelayMs = Number(argv[++i])
    else if (arg === '--min-alpha') args.minAlpha = Number(argv[++i])
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (!Number.isInteger(args.minZoom) || args.minZoom < 0) throw new Error('--min-zoom must be a non-negative integer')
  if (!Number.isInteger(args.maxZoom) || args.maxZoom < args.minZoom) throw new Error('--max-zoom must be >= --min-zoom')
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error('--concurrency must be a positive integer')
  if (!Number.isFinite(args.delayMs) || args.delayMs < 0) throw new Error('--delay-ms must be >= 0')
  if (!Number.isInteger(args.retries) || args.retries < 0) throw new Error('--retries must be >= 0')
  if (!Number.isFinite(args.retryDelayMs) || args.retryDelayMs < 0) throw new Error('--retry-delay-ms must be >= 0')
  if (!Number.isInteger(args.minAlpha) || args.minAlpha < 0 || args.minAlpha > 255) throw new Error('--min-alpha must be 0..255')

  return args
}

function parseBounds(value) {
  const parts = value.split(',').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error('--bounds must be west,south,east,north')
  }
  return { west: parts[0], south: parts[1], east: parts[2], north: parts[3] }
}

async function exists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function lonToTileX(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom)
}

function latToTileY(lat, zoom) {
  const radians = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * 2 ** zoom)
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function tileRangeForBounds(bounds, zoom) {
  const maxIndex = 2 ** zoom - 1
  const west = clamp(lonToTileX(bounds.west, zoom), 0, maxIndex)
  const east = clamp(lonToTileX(bounds.east, zoom), 0, maxIndex)
  const north = clamp(latToTileY(bounds.north, zoom), 0, maxIndex)
  const south = clamp(latToTileY(bounds.south, zoom), 0, maxIndex)
  return {
    minX: Math.min(west, east),
    maxX: Math.max(west, east),
    minY: Math.min(north, south),
    maxY: Math.max(north, south),
  }
}

function enumerateTiles(bounds, minZoom, maxZoom) {
  const tiles = []
  const byZoom = {}
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const range = tileRangeForBounds(bounds, z)
    const count = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1)
    byZoom[z] = { ...range, count }
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        tiles.push({ z, x, y })
      }
    }
  }
  return { tiles, byZoom }
}

function tileUrl(layer, tile) {
  return layer.tileUrl
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y))
}

function tileOutputPath(layer, tile) {
  return path.join(TILE_DIR, layer.layerId, String(tile.z), String(tile.x), `${tile.y}.png`)
}

function layerDownloadManifestPath(layer) {
  return path.join(TILE_DIR, layer.layerId, 'layer-download-manifest.json')
}

function pngStats(bytes, minAlpha) {
  const png = PNG.sync.read(bytes)
  let nonTransparentPixels = 0
  const colors = new Map()
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i]
    const g = png.data[i + 1]
    const b = png.data[i + 2]
    const a = png.data[i + 3]
    if (a < minAlpha) continue
    nonTransparentPixels += 1
    const key = `${r},${g},${b},${a}`
    colors.set(key, (colors.get(key) ?? 0) + 1)
  }
  return {
    width: png.width,
    height: png.height,
    nonTransparentPixels,
    topColors: [...colors.entries()]
      .map(([rgba, pixels]) => ({ rgba, pixels }))
      .sort((a, b) => b.pixels - a.pixels)
      .slice(0, 12),
  }
}

async function fetchTileBytes(url, args) {
  let lastError = null
  for (let attempt = 0; attempt <= args.retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          referer: ROGERS_COVERAGE_URL,
          'user-agent': 'Mozilla/5.0 (compatible; bcdatamapper Rogers coverage scraper)',
        },
      })
      if (response.status === 204 || response.status === 404) return { status: response.status, contentType: null, bytes: Buffer.alloc(0) }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const contentType = response.headers.get('content-type')
      const bytes = Buffer.from(await response.arrayBuffer())
      return { status: response.status, contentType, bytes }
    } catch (error) {
      lastError = error
      if (attempt < args.retries) await sleep(args.retryDelayMs * (attempt + 1))
    }
  }
  throw lastError
}

async function runPool(items, concurrency, worker) {
  let index = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (index < items.length) {
      const currentIndex = index
      index += 1
      await worker(items[currentIndex], currentIndex)
    }
  })
  await Promise.all(workers)
}

async function downloadLayer(layer, tiles, byZoom, sourceManifest, args) {
  await mkdir(path.join(TILE_DIR, layer.layerId), { recursive: true })

  const previous = await exists(layerDownloadManifestPath(layer))
    ? await readJson(layerDownloadManifestPath(layer))
    : null

  const manifest = {
    generatedAt: new Date().toISOString(),
    sourcePageUrl: ROGERS_COVERAGE_URL,
    provider: 'Rogers',
    layerId: layer.layerId,
    label: layer.label,
    style: layer.style,
    tileUrl: layer.tileUrl,
    coverageUpdated: sourceManifest.coverageUpdated ?? null,
    configuredZoomRange: {
      from: layer.zoomRangeFrom ?? null,
      to: layer.zoomRangeTo ?? null,
    },
    requested: {
      minZoom: args.minZoom,
      maxZoom: args.maxZoom,
      bounds: args.bounds,
      tilesByZoom: byZoom,
      concurrency: args.concurrency,
      retries: args.retries,
      minAlpha: args.minAlpha,
      saveEmpty: args.saveEmpty,
    },
    previousGeneratedAt: previous?.generatedAt ?? null,
    stats: {
      candidateTiles: tiles.length,
      downloaded: 0,
      skippedExisting: 0,
      skippedTransparent: 0,
      savedEmpty: 0,
      failed: 0,
      bytesSaved: 0,
    },
    failures: [],
  }

  await runPool(tiles, args.concurrency, async (tile, index) => {
    const outPath = tileOutputPath(layer, tile)
    const existingTileMatchesSource = previous?.coverageUpdated === sourceManifest.coverageUpdated
    if (!args.force && existingTileMatchesSource && await exists(outPath)) {
      manifest.stats.skippedExisting += 1
      return
    }

    const url = tileUrl(layer, tile)
    try {
      const result = await fetchTileBytes(url, args)
      if (result.status !== 200 || result.bytes.length === 0) {
        manifest.stats.skippedTransparent += 1
        return
      }
      if (!String(result.contentType ?? '').includes('png')) {
        throw new Error(`Unexpected content type ${result.contentType}`)
      }

      const stats = pngStats(result.bytes, args.minAlpha)
      if (stats.nonTransparentPixels === 0 && !args.saveEmpty) {
        manifest.stats.skippedTransparent += 1
        return
      }

      await mkdir(path.dirname(outPath), { recursive: true })
      await writeFile(outPath, result.bytes)
      manifest.stats.downloaded += 1
      manifest.stats.bytesSaved += result.bytes.length
      if (stats.nonTransparentPixels === 0) manifest.stats.savedEmpty += 1

      if ((index + 1) % 500 === 0) {
        console.log(`[${layer.layerId}] ${index + 1}/${tiles.length} tiles checked (${manifest.stats.downloaded} saved)`)
      }
      if (args.delayMs > 0) await sleep(args.delayMs)
    } catch (error) {
      manifest.stats.failed += 1
      manifest.failures.push({ tile, url, error: String(error.message ?? error) })
    }
  })

  await writeFile(layerDownloadManifestPath(layer), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

function selectLayers(sourceManifest, layerIds) {
  const layerById = new Map((sourceManifest.layers ?? []).map((layer) => [layer.layerId, layer]))
  return layerIds.map((id) => {
    const layer = layerById.get(id)
    if (!layer) throw new Error(`Unknown Rogers layer "${id}". Run network:rogers:probe and check output/manifest.json.`)
    return layer
  })
}

function prettyBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!await exists(MANIFEST_PATH)) {
    throw new Error('Missing output/manifest.json. Run npm run network:rogers:probe first.')
  }

  await mkdir(TILE_DIR, { recursive: true })
  const sourceManifest = await readJson(MANIFEST_PATH)
  const layers = selectLayers(sourceManifest, args.layers)
  const { tiles, byZoom } = enumerateTiles(args.bounds, args.minZoom, args.maxZoom)

  console.log(`Rogers coverage updated: ${sourceManifest.coverageUpdated ?? 'unknown'}`)
  console.log(`Downloading ${layers.length} layers, ${tiles.length} candidate tiles per layer`)
  console.log(`Requested zooms: ${args.minZoom}-${args.maxZoom}; configured source zooms are recorded per layer`)

  const results = []
  for (const layer of layers) {
    console.log(`\n[${layer.layerId}] ${layer.label} (${layer.style})`)
    const result = await downloadLayer(layer, tiles, byZoom, sourceManifest, args)
    results.push(result)
    console.log(
      `[${layer.layerId}] saved ${result.stats.downloaded} tiles, ` +
      `${prettyBytes(result.stats.bytesSaved)}, failed ${result.stats.failed}`,
    )
  }

  const runManifest = {
    generatedAt: new Date().toISOString(),
    provider: 'Rogers',
    coverageUpdated: sourceManifest.coverageUpdated ?? null,
    requested: {
      layers: args.layers,
      minZoom: args.minZoom,
      maxZoom: args.maxZoom,
      bounds: args.bounds,
      candidateTilesPerLayer: tiles.length,
      tilesByZoom: byZoom,
    },
    totals: {
      downloaded: results.reduce((sum, result) => sum + result.stats.downloaded, 0),
      failed: results.reduce((sum, result) => sum + result.stats.failed, 0),
      bytesSaved: results.reduce((sum, result) => sum + result.stats.bytesSaved, 0),
    },
    layers: results.map((result) => ({
      layerId: result.layerId,
      label: result.label,
      style: result.style,
      configuredZoomRange: result.configuredZoomRange,
      stats: result.stats,
    })),
  }

  await writeFile(path.join(TILE_DIR, 'sync-manifest.json'), `${JSON.stringify(runManifest, null, 2)}\n`)
  console.log(`\nTotal saved: ${runManifest.totals.downloaded} tiles, ${prettyBytes(runManifest.totals.bytesSaved)}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
