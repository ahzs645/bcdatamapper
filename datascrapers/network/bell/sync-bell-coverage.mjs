import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzip } from 'node:zlib'
import { PNG } from 'pngjs'
import { promisify } from 'node:util'

const gzipAsync = promisify(gzip)

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output')
const TILE_DIR = path.join(OUTPUT_DIR, 'tiles')
const POLYGON_DIR = path.join(OUTPUT_DIR, 'polygons')
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')

const BELL_COVERAGE_URL = 'https://www.bell.ca/Mobility/Our_network_coverage'
const CONFIG_URL = 'https://bellmaps.korem.com/Coverage/getSiteConfig?siteId=Bell.ca&callback=callback'
const TILE_BASE_URL = 'https://bellmaps.korem.com/TMS/getTile'
const WORKSPACE = 'Bell.ca'

const DEFAULT_LAYER_ORDER = ['5g-lte', '4g-lte', '4g-hspa', 'lte-m']
const INDIVIDUAL_LAYER_ORDER = ['5g-plus-advanced', '5g-plus', '5g', 'lte-advanced', 'lte', 'hspa', 'lte-m']
const INDIVIDUAL_LAYER_DEFINITIONS = {
  '5g-plus-advanced': {
    label: '5G+ Advanced (5G+A)',
    layers: '5G_PLUS_Advanced',
  },
  '5g-plus': {
    label: '5G+',
    layers: '5G_PLUS',
  },
  '5g': {
    label: '5G',
    layers: '5G',
  },
  'lte-advanced': {
    label: 'LTE Advanced (LTE-A)',
    layers: 'LTE_Advanced',
  },
  'lte': {
    label: 'LTE',
    layers: 'LTE',
  },
  hspa: {
    label: 'HSPA+',
    layers: 'HSPA',
  },
  'lte-m': {
    label: 'LTE-M',
    layers: 'LTE_M',
  },
}

function parseArgs(argv) {
  const args = {
    minZoom: 4,
    maxZoom: 8,
    layers: null,
    step: 'all',
    force: false,
    concurrency: 4,
    delayMs: 0,
    retries: 2,
    retryDelayMs: 2_000,
    timeoutMs: 30_000,
    minAlpha: 16,
    minColorPixels: 32,
    saveEmpty: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--force') args.force = true
    else if (arg === '--save-empty') args.saveEmpty = true
    else if (arg === '--min-zoom') args.minZoom = Number(argv[++i])
    else if (arg === '--max-zoom') args.maxZoom = Number(argv[++i])
    else if (arg === '--layers') args.layers = argv[++i].split(',').map((value) => value.trim()).filter(Boolean)
    else if (arg === '--step') args.step = argv[++i]
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i])
    else if (arg === '--delay-ms') args.delayMs = Number(argv[++i])
    else if (arg === '--retries') args.retries = Number(argv[++i])
    else if (arg === '--retry-delay-ms') args.retryDelayMs = Number(argv[++i])
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i])
    else if (arg === '--min-alpha') args.minAlpha = Number(argv[++i])
    else if (arg === '--min-color-pixels') args.minColorPixels = Number(argv[++i])
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (!Number.isInteger(args.minZoom) || args.minZoom < 0) throw new Error('--min-zoom must be a non-negative integer')
  if (!Number.isInteger(args.maxZoom) || args.maxZoom < args.minZoom) throw new Error('--max-zoom must be >= --min-zoom')
  if (!['all', 'download', 'polygonize'].includes(args.step)) throw new Error('--step must be all, download, or polygonize')
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error('--concurrency must be a positive integer')
  if (!Number.isFinite(args.delayMs) || args.delayMs < 0) throw new Error('--delay-ms must be >= 0')
  if (!Number.isInteger(args.retries) || args.retries < 0) throw new Error('--retries must be >= 0')
  if (!Number.isFinite(args.retryDelayMs) || args.retryDelayMs < 0) throw new Error('--retry-delay-ms must be >= 0')
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1_000) throw new Error('--timeout-ms must be >= 1000')
  if (!Number.isInteger(args.minAlpha) || args.minAlpha < 0 || args.minAlpha > 255) throw new Error('--min-alpha must be 0..255')
  if (!Number.isInteger(args.minColorPixels) || args.minColorPixels < 1) throw new Error('--min-color-pixels must be a positive integer')
  return args
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function exists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

async function fetchText(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return await response.text()
}

async function fetchConfig() {
  const text = await fetchText(CONFIG_URL)
  const jsonText = text.replace(/^callback\(/, '').replace(/\);?$/, '')
  const config = JSON.parse(jsonText)
  const [north, east, south, west] = config.bounds.map(Number)
  return {
    raw: config,
    timestamp: String(config.timestamp),
    bounds: { west, south, east, north },
    layersTechnosMap: config.layersTechnosMap,
    technosOrder: config.technosOrder ?? DEFAULT_LAYER_ORDER,
  }
}

function selectLayers(config, requestedLayerIds) {
  const ids = expandRequestedLayerIds(requestedLayerIds ?? config.technosOrder ?? DEFAULT_LAYER_ORDER)
  return ids.map((id) => {
    const individualLayer = INDIVIDUAL_LAYER_DEFINITIONS[id]
    const layers = individualLayer?.layers ?? config.layersTechnosMap[id]
    if (!layers) {
      throw new Error(
        `Unknown Bell layer "${id}". Available groups: ${Object.keys(config.layersTechnosMap).join(', ')}. ` +
          `Available individual types: ${Object.keys(INDIVIDUAL_LAYER_DEFINITIONS).join(', ')}.`,
      )
    }
    return {
      id,
      provider: 'Bell',
      label: individualLayer?.label ?? bellLayerLabel(id),
      layers,
      type: individualLayer ? 'individual' : 'group',
    }
  })
}

function expandRequestedLayerIds(ids) {
  if (ids.includes('all-types')) return ids.flatMap((id) => id === 'all-types' ? INDIVIDUAL_LAYER_ORDER : [id])
  if (ids.includes('all-groups')) return ids.flatMap((id) => id === 'all-groups' ? DEFAULT_LAYER_ORDER : [id])
  return ids
}

function bellLayerLabel(id) {
  if (id === '5g-lte') return '5G / 5G+'
  if (id === '4g-lte') return 'LTE / LTE Advanced'
  if (id === '4g-hspa') return 'HSPA+'
  if (id === 'lte-m') return 'LTE-M'
  return id
}

function lonToTileX(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom)
}

function latToTileY(lat, zoom) {
  const radians = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * 2 ** zoom)
}

function tileXToLon(x, zoom) {
  return (x / 2 ** zoom) * 360 - 180
}

function tileYToLat(y, zoom) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** zoom
  return (180 / Math.PI) * Math.atan(Math.sinh(n))
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
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const range = tileRangeForBounds(bounds, z)
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        tiles.push({ z, x, y })
      }
    }
  }
  return tiles
}

function bellTileUrl(layer, tile, timestamp) {
  const params = new URLSearchParams({
    workspace: WORKSPACE,
    layers: layer.layers,
    z: String(tile.z + 1),
    x: String(tile.x + 1),
    y: String(tile.y + 1),
    timestamp,
  })
  return `${TILE_BASE_URL}?${params.toString()}`
}

function tileOutputPath(layer, tile) {
  return path.join(TILE_DIR, layer.id, String(tile.z), String(tile.x), `${tile.y}.png`)
}

function layerDownloadManifestPath(layer) {
  return path.join(TILE_DIR, layer.id, 'layer-download-manifest.json')
}

function pngStats(bytes, minAlpha) {
  const png = PNG.sync.read(bytes)
  const colorCounts = new Map()
  let nonTransparentPixels = 0
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i]
    const g = png.data[i + 1]
    const b = png.data[i + 2]
    const a = png.data[i + 3]
    if (a < minAlpha) continue
    nonTransparentPixels += 1
    const key = `${r},${g},${b},${a}`
    colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1)
  }
  return {
    width: png.width,
    height: png.height,
    nonTransparentPixels,
    colors: [...colorCounts.entries()]
      .map(([rgba, pixels]) => ({ rgba, pixels, hex: rgbaToHex(rgba) }))
      .sort((a, b) => b.pixels - a.pixels),
  }
}

function rgbaToHex(rgba) {
  const [r, g, b] = rgba.split(',').map(Number)
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

function parseRgba(rgba) {
  const [r, g, b, a] = rgba.split(',').map(Number)
  return { r, g, b, a }
}

async function fetchTileBytes(url, args) {
  let lastError = null
  for (let attempt = 0; attempt <= args.retries; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), args.timeoutMs)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          referer: BELL_COVERAGE_URL,
          'user-agent': 'Mozilla/5.0 (compatible; bcdatamapper Bell coverage scraper)',
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
    } finally {
      clearTimeout(timeout)
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

async function downloadLayer(layer, tiles, config, args) {
  const layerDir = path.join(TILE_DIR, layer.id)
  await mkdir(layerDir, { recursive: true })

  const previous = await readJsonIfExists(layerDownloadManifestPath(layer))
  const manifest = {
    generatedAt: new Date().toISOString(),
    sourcePageUrl: BELL_COVERAGE_URL,
    sourceConfigUrl: CONFIG_URL,
    sourceTileBaseUrl: TILE_BASE_URL,
    provider: layer.provider,
    layerId: layer.id,
    label: layer.label,
    bellLayers: layer.layers,
    bellTimestamp: config.timestamp,
    requested: {
      minZoom: args.minZoom,
      maxZoom: args.maxZoom,
      concurrency: args.concurrency,
      retries: args.retries,
      timeoutMs: args.timeoutMs,
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
    const existingTileMatchesTimestamp = previous?.bellTimestamp === config.timestamp
    if (!args.force && existingTileMatchesTimestamp && await exists(outPath)) {
      manifest.stats.skippedExisting += 1
      return
    }

    const url = bellTileUrl(layer, tile, config.timestamp)
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

      if ((index + 1) % 250 === 0) {
        console.log(`[${layer.id}] ${index + 1}/${tiles.length} tiles checked (${manifest.stats.downloaded} saved)`)
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

async function walkPngTiles(layer) {
  const layerDir = path.join(TILE_DIR, layer.id)
  const tiles = []
  if (!await exists(layerDir)) return tiles
  const zoomEntries = await readdir(layerDir, { withFileTypes: true })
  for (const zoomEntry of zoomEntries) {
    if (!zoomEntry.isDirectory()) continue
    const z = Number(zoomEntry.name)
    if (!Number.isInteger(z)) continue
    const zoomDir = path.join(layerDir, zoomEntry.name)
    for (const xEntry of await readdir(zoomDir, { withFileTypes: true })) {
      if (!xEntry.isDirectory()) continue
      const x = Number(xEntry.name)
      if (!Number.isInteger(x)) continue
      const xDir = path.join(zoomDir, xEntry.name)
      for (const yEntry of await readdir(xDir, { withFileTypes: true })) {
        if (!yEntry.isFile() || !yEntry.name.endsWith('.png')) continue
        const y = Number(yEntry.name.replace(/\.png$/, ''))
        if (!Number.isInteger(y)) continue
        tiles.push({ z, x, y, path: path.join(xDir, yEntry.name) })
      }
    }
  }
  return tiles.sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y)
}

function rectToPolygon(tile, rect) {
  const west = tileXToLon(tile.x + rect.x0 / 256, tile.z)
  const east = tileXToLon(tile.x + rect.x1 / 256, tile.z)
  const north = tileYToLat(tile.y + rect.y0 / 256, tile.z)
  const south = tileYToLat(tile.y + rect.y1 / 256, tile.z)
  return [[
    [roundCoord(west), roundCoord(north)],
    [roundCoord(east), roundCoord(north)],
    [roundCoord(east), roundCoord(south)],
    [roundCoord(west), roundCoord(south)],
    [roundCoord(west), roundCoord(north)],
  ]]
}

function roundCoord(value) {
  return Math.round(value * 1e7) / 1e7
}

function rectanglesForColor(png, colorKey) {
  const active = new Map()
  const completed = []

  for (let y = 0; y < png.height; y += 1) {
    const rowRuns = []
    let x = 0
    while (x < png.width) {
      while (x < png.width && pixelColorKey(png, x, y) !== colorKey) x += 1
      if (x >= png.width) break
      const x0 = x
      while (x < png.width && pixelColorKey(png, x, y) === colorKey) x += 1
      rowRuns.push({ x0, x1: x })
    }

    const seen = new Set()
    for (const run of rowRuns) {
      const key = `${run.x0},${run.x1}`
      const existing = active.get(key)
      if (existing) {
        existing.y1 = y + 1
      } else {
        active.set(key, { x0: run.x0, x1: run.x1, y0: y, y1: y + 1 })
      }
      seen.add(key)
    }

    for (const [key, rect] of [...active.entries()]) {
      if (!seen.has(key)) {
        completed.push(rect)
        active.delete(key)
      }
    }
  }

  completed.push(...active.values())
  return completed
}

function pixelColorKey(png, x, y) {
  const offset = (y * png.width + x) * 4
  return `${png.data[offset]},${png.data[offset + 1]},${png.data[offset + 2]},${png.data[offset + 3]}`
}

async function fileSha256(filePath) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve)
  })
  return hash.digest('hex')
}

async function polygonizeLayer(layer, args, config) {
  await mkdir(POLYGON_DIR, { recursive: true })
  const pngTiles = await walkPngTiles(layer)
  const outputPath = path.join(POLYGON_DIR, `${layer.id}.geojson.gz`)
  const features = []
  const colorTotals = new Map()
  const stats = {
    sourceTiles: pngTiles.length,
    featureCount: 0,
    rectangleCount: 0,
    pixelCount: 0,
    droppedColorPixelCount: 0,
  }

  for (const tile of pngTiles) {
    const bytes = await readFile(tile.path)
    const png = PNG.sync.read(bytes)
    const tileStats = pngStats(bytes, args.minAlpha)
    const eligibleColors = tileStats.colors.filter((color) => color.pixels >= args.minColorPixels)
    const droppedPixels = tileStats.colors
      .filter((color) => color.pixels < args.minColorPixels)
      .reduce((sum, color) => sum + color.pixels, 0)
    stats.droppedColorPixelCount += droppedPixels

    for (const color of eligibleColors) {
      colorTotals.set(color.rgba, (colorTotals.get(color.rgba) ?? 0) + color.pixels)
      const rects = rectanglesForColor(png, color.rgba)
      const rgba = parseRgba(color.rgba)
      for (const rect of rects) {
        const pixelCount = (rect.x1 - rect.x0) * (rect.y1 - rect.y0)
        features.push({
          type: 'Feature',
          properties: {
            provider: layer.provider,
            source: 'Bell public coverage PNG tile polygonization',
            layerId: layer.id,
            label: layer.label,
            bellLayers: layer.layers,
            colorHex: color.hex,
            colorRgba: color.rgba,
            r: rgba.r,
            g: rgba.g,
            b: rgba.b,
            a: rgba.a,
            mapZoom: tile.z,
            tileX: tile.x,
            tileY: tile.y,
            pixelX0: rect.x0,
            pixelY0: rect.y0,
            pixelX1: rect.x1,
            pixelY1: rect.y1,
            pixelCount,
          },
          geometry: {
            type: 'Polygon',
            coordinates: rectToPolygon(tile, rect),
          },
        })
        stats.rectangleCount += 1
        stats.pixelCount += pixelCount
      }
    }
  }

  stats.featureCount = features.length
  const geojson = {
    type: 'FeatureCollection',
    name: `bell-${layer.id}-polygonized-coverage`,
    metadata: {
      generatedAt: new Date().toISOString(),
      sourcePageUrl: BELL_COVERAGE_URL,
      sourceConfigUrl: CONFIG_URL,
      sourceTileBaseUrl: TILE_BASE_URL,
      provider: layer.provider,
      layerId: layer.id,
      label: layer.label,
      bellLayers: layer.layers,
      bellTimestamp: config.timestamp,
      bounds: config.bounds,
      method: 'Raster PNG tiles decoded by exact RGBA color. Same-color horizontal pixel runs are merged vertically into rectangle polygons and projected from Web Mercator tile coordinates to EPSG:4326.',
      limitation: 'Approximate derived vector output. Bell does not expose native coverage polygons in the inspected public app, and this output is not dissolved across tile boundaries.',
      minAlpha: args.minAlpha,
      minColorPixels: args.minColorPixels,
      colorTotals: [...colorTotals.entries()].map(([rgba, pixels]) => ({ rgba, hex: rgbaToHex(rgba), pixels })),
      stats,
    },
    features,
  }

  const compressed = await gzipAsync(Buffer.from(`${JSON.stringify(geojson)}\n`), { level: 9 })
  await writeFile(outputPath, compressed)
  return {
    layerId: layer.id,
    label: layer.label,
    outputPath,
    outputBytes: compressed.length,
    sha256: await fileSha256(outputPath),
    stats,
  }
}

function prettyBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  await mkdir(OUTPUT_DIR, { recursive: true })
  await mkdir(TILE_DIR, { recursive: true })

  const config = await fetchConfig()
  const layers = selectLayers(config, args.layers)
  const tiles = enumerateTiles(config.bounds, args.minZoom, args.maxZoom)

  const manifest = {
    generatedAt: new Date().toISOString(),
    sourcePageUrl: BELL_COVERAGE_URL,
    sourceConfigUrl: CONFIG_URL,
    sourceTileBaseUrl: TILE_BASE_URL,
    provider: 'Bell',
    bellTimestamp: config.timestamp,
    bounds: config.bounds,
    requested: {
      minZoom: args.minZoom,
      maxZoom: args.maxZoom,
      layers: layers.map((layer) => layer.id),
      step: args.step,
      force: args.force,
      concurrency: args.concurrency,
      minAlpha: args.minAlpha,
      minColorPixels: args.minColorPixels,
    },
    notes: [
      'Bell public coverage is exposed as Korem/Google ImageMapType PNG tiles, not native polygons or MVT.',
      'Bell tile requests use sourceZ = mapZoom + 1 and one-based source x/y. Output paths use zero-based Google/XYZ map z/x/y.',
      'Polygon output is an approximate raster-derived vector snapshot and is not dissolved across tiles.',
    ],
    candidateTilesPerLayer: tiles.length,
    layers: [],
  }

  for (const layer of layers) {
    console.log(`[${layer.id}] ${layer.label}: ${tiles.length} candidate tiles`)
    const layerResult = {
      id: layer.id,
      label: layer.label,
      bellLayers: layer.layers,
      download: null,
      polygonize: null,
    }

    if (args.step === 'all' || args.step === 'download') {
      layerResult.download = await downloadLayer(layer, tiles, config, args)
      console.log(
        `[${layer.id}] downloaded ${layerResult.download.stats.downloaded}, skipped existing ${layerResult.download.stats.skippedExisting}, skipped transparent ${layerResult.download.stats.skippedTransparent}, failed ${layerResult.download.stats.failed}, saved ${prettyBytes(layerResult.download.stats.bytesSaved)}`,
      )
    }

    if (args.step === 'all' || args.step === 'polygonize') {
      layerResult.polygonize = await polygonizeLayer(layer, args, config)
      console.log(
        `[${layer.id}] polygonized ${layerResult.polygonize.stats.sourceTiles} tiles -> ${layerResult.polygonize.stats.featureCount} features (${prettyBytes(layerResult.polygonize.outputBytes)} gz)`,
      )
    }

    manifest.layers.push(layerResult)
  }

  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote ${MANIFEST_PATH}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
