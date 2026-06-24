import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output')
const TILE_DIR = path.join(OUTPUT_DIR, 'tiles')
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')

const TELUS_COVERAGE_URL = 'https://www.telus.com/en/mobility/network/coverage-map'
const TILESET_BASE = 'https://www.telus.com/network/tools/coverage-map/api/carto/v3/maps/public-coverage-map/tileset'
const CLIENT_PARAMS = 'v=3.4&client=deck-gl-carto&deckglVersion=9.1.2'

const TILESETS = [
  {
    id: 'telus-lte',
    label: 'LTE',
    name: 'cto-cartobackend-pr-d23fd8.public_telus_coverage_map_pr.coverage-lte-tileset-1779912989',
    cache: '1779913921257',
  },
  {
    id: 'telus-lte-advanced',
    label: 'LTE Advanced',
    name: 'cto-cartobackend-pr-d23fd8.public_telus_coverage_map_pr.coverage-lte-advanced-tileset-1779912963',
    cache: '1779913618111',
  },
  {
    id: 'telus-5g',
    label: '5G',
    name: 'cto-cartobackend-pr-d23fd8.public_telus_coverage_map_pr.coverage-5g-tileset-1779912967',
    cache: '1779913884618',
  },
  {
    id: 'telus-5g-3500',
    label: '5G+ / 3500 MHz',
    name: 'cto-cartobackend-pr-d23fd8.public_telus_coverage_map_pr.coverage-5g-3500-tileset-1779912930',
    cache: '1779913381741',
  },
  {
    id: 'telus-hspa',
    label: 'HSPA+',
    name: 'cto-cartobackend-pr-d23fd8.public_telus_coverage_map_pr.coverage-hspa-tileset-1776278219',
    cache: '1776278953170',
  },
  {
    id: 'telus-lte-m',
    label: 'LTE-M / IoT',
    name: 'cto-cartobackend-pr-d23fd8.public_telus_coverage_map_pr.coverage-lte-m-tileset-1779912967',
    cache: '1779913623017',
  },
]

function parseArgs(argv) {
  const args = {
    minZoom: 0,
    maxZoom: 8,
    concurrency: 1,
    delayMs: 300,
    retryDelayMs: 5_000,
    retries: 2,
    force: false,
    headless: false,
    layers: null,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--force') args.force = true
    else if (arg === '--headless') args.headless = true
    else if (arg === '--headed') args.headless = false
    else if (arg === '--min-zoom') args.minZoom = Number(argv[++i])
    else if (arg === '--max-zoom') args.maxZoom = Number(argv[++i])
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i])
    else if (arg === '--delay-ms') args.delayMs = Number(argv[++i])
    else if (arg === '--retry-delay-ms') args.retryDelayMs = Number(argv[++i])
    else if (arg === '--retries') args.retries = Number(argv[++i])
    else if (arg === '--layers') args.layers = argv[++i].split(',').map((value) => value.trim()).filter(Boolean)
  }

  if (!Number.isInteger(args.minZoom) || args.minZoom < 0) throw new Error('--min-zoom must be a non-negative integer')
  if (!Number.isInteger(args.maxZoom) || args.maxZoom < args.minZoom) throw new Error('--max-zoom must be >= --min-zoom')
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error('--concurrency must be a positive integer')
  if (!Number.isFinite(args.delayMs) || args.delayMs < 0) throw new Error('--delay-ms must be >= 0')
  if (!Number.isFinite(args.retryDelayMs) || args.retryDelayMs < 0) throw new Error('--retry-delay-ms must be >= 0')
  if (!Number.isInteger(args.retries) || args.retries < 0) throw new Error('--retries must be >= 0')
  return args
}

function tilejsonUrl(tileset) {
  return `${TILESET_BASE}?format=tilejson&name=${encodeURIComponent(tileset.name)}&cache=${encodeURIComponent(tileset.cache)}&${CLIENT_PARAMS}`
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
  const west = clamp(lonToTileX(bounds[0], zoom), 0, maxIndex)
  const east = clamp(lonToTileX(bounds[2], zoom), 0, maxIndex)
  const north = clamp(latToTileY(bounds[3], zoom), 0, maxIndex)
  const south = clamp(latToTileY(bounds[1], zoom), 0, maxIndex)
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

function tileUrl(template, tile) {
  return template.replace('{z}', tile.z).replace('{x}', tile.x).replace('{y}', tile.y)
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

async function fetchTilejson(page, tileset) {
  const url = tilejsonUrl(tileset)
  return await page.evaluate(async (requestUrl) => {
    const response = await fetch(requestUrl, { credentials: 'include' })
    if (!response.ok) throw new Error(`${requestUrl} returned HTTP ${response.status}`)
    return await response.json()
  }, url)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchTileViaPage(page, url, args) {
  const waitForResponse = page.waitForResponse((response) => response.url() === url, { timeout: 30_000 })
  await page.evaluate((requestUrl) => fetch(requestUrl, { credentials: 'include' }).then((response) => response.arrayBuffer()), url)
  const response = await waitForResponse
  const contentType = response.headers()['content-type'] ?? null
  if (response.status() === 204) return { status: 204, contentType, bytes: Buffer.alloc(0) }
  const bytes = await response.body()
  const result = { status: response.status(), contentType, bytes }
  if (args.delayMs > 0) await sleep(args.delayMs)
  return result
}

async function fetchTileWithRetry(page, url, args) {
  let lastResult = null
  for (let attempt = 0; attempt <= args.retries; attempt += 1) {
    const result = await fetchTileViaPage(page, url, args)
    lastResult = result
    if (result.status !== 429) return result
    if (attempt < args.retries) await sleep(args.retryDelayMs * (attempt + 1))
  }
  return lastResult
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

function prettyBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  await mkdir(TILE_DIR, { recursive: true })

  const selectedTilesets = TILESETS.filter((tileset) => !args.layers || args.layers.includes(tileset.id))
  if (selectedTilesets.length === 0) throw new Error(`No TELUS tilesets matched --layers ${args.layers?.join(',')}`)

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: args.headless,
  })

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.goto(TELUS_COVERAGE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForTimeout(8_000)

    const manifest = {
      generatedAt: new Date().toISOString(),
      sourcePageUrl: TELUS_COVERAGE_URL,
      outputDir: OUTPUT_DIR,
      requested: {
        minZoom: args.minZoom,
        maxZoom: args.maxZoom,
        concurrency: args.concurrency,
        delayMs: args.delayMs,
        retries: args.retries,
        retryDelayMs: args.retryDelayMs,
        layers: selectedTilesets.map((tileset) => tileset.id),
      },
      notes: [
        'TELUS exposes coverage as CARTO/deck.gl MVT vector tiles behind the public coverage-map app.',
        'Direct terminal HTTP requests are Cloudflare-blocked in this environment, so this scraper uses a normal Chrome page session and fetches tile URLs inside that page context.',
        'Raw MVT files are preserved for later comparison/conversion rather than dissolved to GeoJSON here.',
      ],
      layers: [],
    }

    for (const tileset of selectedTilesets) {
      const layerDir = path.join(TILE_DIR, tileset.id)
      await mkdir(layerDir, { recursive: true })

      const previousLayerManifest = await readJsonIfExists(path.join(layerDir, 'layer-manifest.json'))
      let tilejson
      for (let attempt = 0; attempt <= args.retries; attempt += 1) {
        try {
          tilejson = await fetchTilejson(page, tileset)
          break
        } catch (error) {
          if (attempt >= args.retries || !String(error.message).includes('HTTP 429')) throw error
          await sleep(args.retryDelayMs * (attempt + 1))
        }
      }
      const tileTemplate = tilejson.tiles?.[0]
      if (!tileTemplate) throw new Error(`No tile template for ${tileset.id}`)

      const availableMaxZoom = Number(tilejson.maxzoom ?? 12)
      const effectiveMaxZoom = Math.min(args.maxZoom, availableMaxZoom)
      const tiles = enumerateTiles(tilejson.bounds, args.minZoom, effectiveMaxZoom)
      const fullTiles = enumerateTiles(tilejson.bounds, Number(tilejson.minzoom ?? 0), availableMaxZoom)

      const summary = {
        ...tileset,
        tilejsonUrl: tilejsonUrl(tileset),
        tileTemplate,
        minzoom: tilejson.minzoom,
        maxzoom: tilejson.maxzoom,
        bounds: tilejson.bounds,
        vectorLayers: tilejson.vector_layers ?? [],
        candidateTilesAtRequestedZooms: tiles.length,
        candidateTilesAtNativeZooms: fullTiles.length,
        savedTiles: 0,
        skippedExistingTiles: 0,
        emptyTiles: 0,
        failedTiles: 0,
        bytes: 0,
        failures: [],
        previousRun: previousLayerManifest
          ? {
              generatedAt: previousLayerManifest.generatedAt,
              savedTiles: previousLayerManifest.savedTiles,
              bytes: previousLayerManifest.bytes,
            }
          : null,
      }

      console.log(`telus: ${tileset.id} ${tiles.length.toLocaleString()} candidate tiles, native full count ${fullTiles.length.toLocaleString()}`)

      await runPool(tiles, args.concurrency, async (tile, tileIndex) => {
        const relativePath = path.join(String(tile.z), String(tile.x), `${tile.y}.mvt`)
        const outputPath = path.join(layerDir, relativePath)
        if (!args.force && await exists(outputPath)) {
          summary.skippedExistingTiles += 1
          return
        }

        const url = tileUrl(tileTemplate, tile)
        try {
          const result = await fetchTileWithRetry(page, url, args)
          if (result.status === 204 || result.bytes.byteLength === 0) {
            summary.emptyTiles += 1
            return
          }
          if (result.status < 200 || result.status >= 300) {
            summary.failedTiles += 1
            if (summary.failures.length < 20) summary.failures.push({ tile, status: result.status, contentType: result.contentType })
            return
          }
          await mkdir(path.dirname(outputPath), { recursive: true })
          await writeFile(outputPath, result.bytes)
          summary.savedTiles += 1
          summary.bytes += result.bytes.byteLength
        } catch (error) {
          summary.failedTiles += 1
          if (summary.failures.length < 20) summary.failures.push({ tile, error: error.message })
        }

        if ((tileIndex + 1) % 250 === 0) {
          console.log(
            `telus: ${tileset.id} ${tileIndex + 1}/${tiles.length} saved=${summary.savedTiles} empty=${summary.emptyTiles} failed=${summary.failedTiles} bytes=${prettyBytes(summary.bytes)}`,
          )
        }
      })

      await writeFile(path.join(layerDir, 'tilejson.json'), `${JSON.stringify(tilejson, null, 2)}\n`)
      await writeFile(path.join(layerDir, 'layer-manifest.json'), `${JSON.stringify(summary, null, 2)}\n`)
      manifest.layers.push(summary)
      console.log(
        `telus: ${tileset.id} done saved=${summary.savedTiles} empty=${summary.emptyTiles} failed=${summary.failedTiles} bytes=${prettyBytes(summary.bytes)}`,
      )
    }

    manifest.totals = manifest.layers.reduce(
      (totals, layer) => ({
        candidateTilesAtRequestedZooms: totals.candidateTilesAtRequestedZooms + layer.candidateTilesAtRequestedZooms,
        candidateTilesAtNativeZooms: totals.candidateTilesAtNativeZooms + layer.candidateTilesAtNativeZooms,
        savedTiles: totals.savedTiles + layer.savedTiles,
        skippedExistingTiles: totals.skippedExistingTiles + layer.skippedExistingTiles,
        emptyTiles: totals.emptyTiles + layer.emptyTiles,
        failedTiles: totals.failedTiles + layer.failedTiles,
        bytes: totals.bytes + layer.bytes,
      }),
      {
        candidateTilesAtRequestedZooms: 0,
        candidateTilesAtNativeZooms: 0,
        savedTiles: 0,
        skippedExistingTiles: 0,
        emptyTiles: 0,
        failedTiles: 0,
        bytes: 0,
      },
    )

    await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`telus: wrote ${MANIFEST_PATH}`)
    console.log(`telus: total saved=${manifest.totals.savedTiles} empty=${manifest.totals.emptyTiles} failed=${manifest.totals.failedTiles} bytes=${prettyBytes(manifest.totals.bytes)}`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
