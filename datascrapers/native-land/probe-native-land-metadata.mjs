import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const OUTPUT_DIR = 'data-sources/native-land'
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')
const RECORDS_PATH = path.join(OUTPUT_DIR, 'entries.json')
const STYLE_PATH = path.join(OUTPUT_DIR, 'map-style-summary.json')

const SEARCHER_URL = 'https://native-land.ca/api/entry/searcher'
const MAP_PAGE_URL = 'https://native-land.ca/maps/native-land'
const API_DOCS_URL = 'https://api-docs.native-land.ca/by-names-and-or-position'
const MAPBOX_STYLE_ID = 'nativeland/cm1ikupww055601r7e4rsem95'

const DEFAULT_MAX_ID = 3500
const DEFAULT_STOP_AFTER_MISSES = 250
const DEFAULT_DELAY_MS = 75
const DEFAULT_CONCURRENCY = 8
const DEFAULT_CATEGORIES = 'territories,languages,treaties,greetings'
const DEFAULT_TIMEOUT_MS = 20_000

function parseArgs(argv) {
  const options = {
    maxId: DEFAULT_MAX_ID,
    stopAfterMisses: DEFAULT_STOP_AFTER_MISSES,
    delayMs: DEFAULT_DELAY_MS,
    concurrency: DEFAULT_CONCURRENCY,
    categories: DEFAULT_CATEGORIES,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--max-id' && next) {
      options.maxId = Number(next)
      index += 1
    } else if (arg === '--stop-after-misses' && next) {
      options.stopAfterMisses = Number(next)
      index += 1
    } else if (arg === '--delay-ms' && next) {
      options.delayMs = Number(next)
      index += 1
    } else if (arg === '--concurrency' && next) {
      options.concurrency = Number(next)
      index += 1
    } else if (arg === '--categories' && next) {
      options.categories = next
      index += 1
    } else if (arg === '--help') {
      console.log(
        `Usage: node probe-native-land-metadata.mjs [--max-id ${DEFAULT_MAX_ID}] [--stop-after-misses ${DEFAULT_STOP_AFTER_MISSES}] [--delay-ms ${DEFAULT_DELAY_MS}] [--concurrency ${DEFAULT_CONCURRENCY}] [--categories ${DEFAULT_CATEGORIES}|all]`,
      )
      process.exit(0)
    }
  }

  for (const [key, value] of Object.entries(options)) {
    if (key === 'categories') continue
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid ${key}: ${value}`)
    }
  }

  return options
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: 'application/json,text/plain,*/*',
        'user-agent': 'PGMaps bcdatamapper Native Land metadata probe',
        ...(options.headers ?? {}),
      },
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`)
  }
  return response.json()
}

function entryUrl(id, categories) {
  const params = new URLSearchParams({
    id: String(id),
    geosearch: 'true',
  })
  if (categories && categories !== 'all') {
    params.set('category', categories)
  }
  return `${SEARCHER_URL}?${params.toString()}`
}

async function probeEntry(id, categories) {
  try {
    const data = await fetchJson(entryUrl(id, categories))
    const results = Array.isArray(data) ? data : []
    const categorySet = categories && categories !== 'all' ? new Set(categories.split(',').map((category) => category.trim()).filter(Boolean)) : null
    const entries = results
      .filter((result) => Number(result.id) === id && result.category && result.name)
      .filter((result) => !categorySet || categorySet.has(result.category))
      .map(normalizeEntry)
    return {
      id,
      entries,
      misses: entries.length ? [] : [{ id, error: 'no result' }],
    }
  } catch (error) {
    return {
      id,
      entries: [],
      misses: [{ id, error: error.message }],
    }
  }
}

function normalizeEntry(entry) {
  return {
    id: entry.id,
    category: entry.category,
    name: entry.name,
    centroid: entry.centroid ?? null,
    bounds: entry.bounds ?? null,
  }
}

function summarizeEntries(entries) {
  const byCategory = {}
  const bounds = {
    west: Infinity,
    south: Infinity,
    east: -Infinity,
    north: -Infinity,
  }

  for (const entry of entries) {
    byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1
    const ring = entry.bounds?.coordinates?.[0]
    if (!Array.isArray(ring)) continue
    for (const coordinate of ring) {
      if (!Array.isArray(coordinate) || coordinate.length < 2) continue
      bounds.west = Math.min(bounds.west, coordinate[0])
      bounds.south = Math.min(bounds.south, coordinate[1])
      bounds.east = Math.max(bounds.east, coordinate[0])
      bounds.north = Math.max(bounds.north, coordinate[1])
    }
  }

  return {
    totalEntries: entries.length,
    byCategory,
    idRange: entries.length
      ? {
          min: Math.min(...entries.map((entry) => entry.id)),
          max: Math.max(...entries.map((entry) => entry.id)),
        }
      : null,
    aggregateBounds: Number.isFinite(bounds.west) ? bounds : null,
    estimatedEntriesJsonBytes: Buffer.byteLength(`${JSON.stringify(entries)}\n`, 'utf8'),
  }
}

async function probeEntries(options) {
  const entries = []
  const misses = []
  let consecutiveMisses = 0

  for (let batchStart = 1; batchStart <= options.maxId; batchStart += options.concurrency) {
    const ids = Array.from(
      { length: Math.min(options.concurrency, options.maxId - batchStart + 1) },
      (_, index) => batchStart + index,
    )
    const results = await Promise.all(ids.map((id) => probeEntry(id, options.categories)))

    for (const result of results.sort((a, b) => a.id - b.id)) {
      if (result.entries.length) {
        entries.push(...result.entries)
        consecutiveMisses = 0
      } else {
        consecutiveMisses += 1
      }
      misses.push(...result.misses)
    }

    const batchEnd = ids[ids.length - 1]
    process.stdout.write(`\rnative-land: probed through id ${batchEnd}, entries ${entries.length}, trailing misses ${consecutiveMisses}`)

    if (consecutiveMisses >= options.stopAfterMisses) {
      break
    }

    if (options.delayMs > 0) {
      await sleep(options.delayMs)
    }
  }

  process.stdout.write('\n')
  return { entries, misses }
}

async function probeMapStyle() {
  const token = process.env.NATIVE_LAND_MAPBOX_TOKEN
  if (!token) {
    return {
      name: null,
      version: null,
      sourceUrl: null,
      nativeLayers: [],
      skipped: 'Set NATIVE_LAND_MAPBOX_TOKEN to probe the public Native Land Mapbox style.',
    }
  }

  const styleUrl = `https://api.mapbox.com/styles/v1/${MAPBOX_STYLE_ID}?${new URLSearchParams({ access_token: token }).toString()}`
  const style = await fetchJson(styleUrl)
  const nativeLayers = (style.layers ?? [])
    .filter((layer) => String(layer.id ?? '').includes('territories') || ['languages', 'treaties', 'greetings'].includes(layer.id))
    .map((layer) => ({
      id: layer.id,
      type: layer.type,
      source: layer.source,
      sourceLayer: layer['source-layer'],
      minzoom: layer.minzoom ?? null,
      maxzoom: layer.maxzoom ?? null,
    }))

  return {
    name: style.name,
    version: style.version,
    sourceUrl: style.sources?.composite?.url ?? null,
    nativeLayers,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  await mkdir(OUTPUT_DIR, { recursive: true })

  const [styleSummary, entryProbe] = await Promise.all([probeMapStyle(), probeEntries(options)])
  const entries = entryProbe.entries.sort((a, b) => a.id - b.id)
  const summary = summarizeEntries(entries)

  const manifest = {
    generatedAt: new Date().toISOString(),
    title: 'Native Land Digital public metadata probe',
    source: {
      mapPageUrl: MAP_PAGE_URL,
      apiDocsUrl: API_DOCS_URL,
      searcherUrl: SEARCHER_URL,
      mapboxStyleUrl: `https://api.mapbox.com/styles/v1/${MAPBOX_STYLE_ID}?access_token=<redacted>`,
    },
    caveat:
      'This is a probe of public website metadata, not a complete export of Native Land Digital geometry. Full point/name GeoJSON access is through the key-gated Native Land API.',
    requestPolicy: {
      maxId: options.maxId,
      stopAfterMisses: options.stopAfterMisses,
      delayMs: options.delayMs,
      categories: options.categories,
    },
    summary,
    misses: {
      count: entryProbe.misses.length,
      first: entryProbe.misses.slice(0, 20),
      last: entryProbe.misses.slice(-20),
    },
    outputs: {
      entries: RECORDS_PATH,
      mapStyleSummary: STYLE_PATH,
    },
  }

  await writeFile(RECORDS_PATH, `${JSON.stringify(entries, null, 2)}\n`)
  await writeFile(STYLE_PATH, `${JSON.stringify(styleSummary, null, 2)}\n`)
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`native-land: wrote ${entries.length} entries to ${RECORDS_PATH}`)
  console.log(`native-land: wrote manifest to ${MANIFEST_PATH}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
