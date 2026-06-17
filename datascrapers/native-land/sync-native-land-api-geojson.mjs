import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

import { SNAPSHOT_DIR, copySnapshotToPublic } from './native-land-snapshot.mjs'

const OUTPUT_DIR = SNAPSHOT_DIR
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')
const API_BASE = 'https://native-land.ca/api/polygons/geojson'
const DOCS_URL = 'https://api-docs.native-land.ca/full-geojsons'
const TREATY_URL = 'https://api-docs.native-land.ca/data-sovereignty-treaty'
const DEFAULT_CATEGORIES = ['territories', 'languages', 'treaties']
const DEFAULT_TIMEOUT_MS = 120_000

function parseArgs(argv) {
  const options = {
    categories: DEFAULT_CATEGORIES,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--categories' && next) {
      options.categories = next.split(',').map((category) => category.trim()).filter(Boolean)
      index += 1
    } else if (arg === '--help') {
      console.log('Usage: NATIVE_LAND_API_KEY=... node sync-native-land-api-geojson.mjs [--categories territories,languages,treaties]')
      process.exit(0)
    }
  }

  const invalid = options.categories.filter((category) => !DEFAULT_CATEGORIES.includes(category))
  if (invalid.length) {
    throw new Error(`Unsupported Native Land category: ${invalid.join(', ')}`)
  }

  return options
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: 'application/geo+json,application/json,*/*',
        'user-agent': 'PGMaps bcdatamapper Native Land API GeoJSON sync',
        ...(options.headers ?? {}),
      },
    })
  } finally {
    clearTimeout(timeout)
  }
}

function apiUrl(category, apiKey) {
  const params = new URLSearchParams({ key: apiKey })
  return `${API_BASE}/${category}?${params.toString()}`
}

function redactedApiUrl(category) {
  return `${API_BASE}/${category}?key=<redacted>`
}

function mergeBounds(bounds, geometry) {
  if (!geometry) return bounds
  const next = bounds ?? {
    west: Infinity,
    south: Infinity,
    east: -Infinity,
    north: -Infinity,
  }

  const visit = (value) => {
    if (!Array.isArray(value)) return
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      next.west = Math.min(next.west, value[0])
      next.south = Math.min(next.south, value[1])
      next.east = Math.max(next.east, value[0])
      next.north = Math.max(next.north, value[1])
      return
    }
    for (const child of value) visit(child)
  }

  visit(geometry.coordinates)
  return next
}

function finalizeBounds(bounds) {
  if (!bounds || !Number.isFinite(bounds.west)) return null
  return bounds
}

function summarizeFeatureCollection(collection, rawText) {
  const features = Array.isArray(collection.features) ? collection.features : []
  const geometryTypes = {}
  const propertyKeys = new Set()
  let bounds = null

  for (const feature of features) {
    const geometryType = feature.geometry?.type ?? 'null'
    geometryTypes[geometryType] = (geometryTypes[geometryType] ?? 0) + 1
    bounds = mergeBounds(bounds, feature.geometry)
    for (const key of Object.keys(feature.properties ?? {})) {
      propertyKeys.add(key)
    }
  }

  return {
    featureCount: features.length,
    geometryTypes,
    propertyKeys: [...propertyKeys].sort(),
    bounds: finalizeBounds(bounds),
    bytes: Buffer.byteLength(rawText, 'utf8'),
    gzipBytes: zlib.gzipSync(rawText).byteLength,
    sampleProperties: features.slice(0, 3).map((feature) => feature.properties ?? {}),
  }
}

async function fetchCategory(category, apiKey) {
  const response = await fetchWithTimeout(apiUrl(category, apiKey))
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Native Land ${category} GeoJSON returned ${response.status}: ${text.slice(0, 200)}`)
  }

  let collection
  try {
    collection = JSON.parse(text)
  } catch (error) {
    throw new Error(`Native Land ${category} did not return JSON: ${error.message}`)
  }

  if (collection.type !== 'FeatureCollection') {
    throw new Error(`Native Land ${category} returned ${collection.type ?? typeof collection}, expected FeatureCollection`)
  }

  const outputPath = path.join(OUTPUT_DIR, `${category}.geojson`)
  await writeFile(outputPath, `${JSON.stringify(collection)}\n`)

  return {
    category,
    output: `/data/native-land/${category}.geojson`,
    sourceUrl: redactedApiUrl(category),
    ...summarizeFeatureCollection(collection, text),
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const apiKey = process.env.NATIVE_LAND_API_KEY
  if (!apiKey) {
    throw new Error('Set NATIVE_LAND_API_KEY before running this script. Do not commit the key.')
  }

  await mkdir(OUTPUT_DIR, { recursive: true })
  const datasets = []
  for (const category of options.categories) {
    console.log(`native-land-api: fetching ${category}`)
    datasets.push(await fetchCategory(category, apiKey))
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    title: 'Native Land Digital API GeoJSON bundled snapshot',
    docsUrl: DOCS_URL,
    dataSovereigntyTreatyUrl: TREATY_URL,
    caveat:
      'Bundled key-backed extract. Confirm Native Land Digital redistribution permission before publishing or sharing this snapshot outside approved uses.',
    categories: options.categories,
    datasets,
  }

  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`native-land-api: wrote manifest to ${MANIFEST_PATH}`)
  const { dest, files } = await copySnapshotToPublic()
  console.log(`native-land-api: copied ${files.length} snapshot file(s) to ${dest}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
