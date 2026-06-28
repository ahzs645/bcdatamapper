import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { point } from '@turf/helpers'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_BOUNDARY_PATH = path.join(ROOT, 'datascrapers/citypg/output/community_boundaries.geojson')
const OUTPUT_DIR = path.join(ROOT, 'datascrapers/open-litter-map/output')
const API_URL = 'https://openlittermap.com/api/points'
const SOURCE_MAP_URL = 'https://openlittermap.com/global?lat=53.894055&lon=-122.766838&zoom=12.00'
const USER_AGENT = 'PGMaps bcdatamapper OpenLitterMap sync (contact: https://pgmaps.ca)'
const DEDICATION = 'This Prince George litter map is dedicated to the memory of Frank Ogiamien, whose OpenLitterMap contributions make up much of the local record.'

const args = parseArgs(process.argv.slice(2))
const boundaryPath = args.boundary ?? DEFAULT_BOUNDARY_PATH
const requestDelayMs = Number(args.delayMs ?? args['delay-ms'] ?? 1150)
const zoom = Number(args.zoom ?? 15)
const hexSizeM = Number(args.hexSizeM ?? args['hex-size-m'] ?? 350)

if (zoom < 15) {
  throw new Error('OpenLitterMap /api/points requires zoom >= 15')
}

await mkdir(OUTPUT_DIR, { recursive: true })
await Promise.all(
  [
    'open_litter_map_pg.geojson',
    'open_litter_map_pg_hex.geojson',
    'open_litter_map_pg_hex.geojson.gz',
  ].map((file) => rm(path.join(OUTPUT_DIR, file), { force: true })),
)

const boundary = JSON.parse(await readFile(boundaryPath, 'utf8'))
const boundaryFeatures = (boundary.features ?? []).filter((feature) => feature.geometry)
const bbox = boundsForFeatures(boundaryFeatures)

console.log(`open-litter-map: fetching PG bbox ${bbox.map((value) => value.toFixed(6)).join(', ')} at zoom ${zoom}`)

const rawFeatures = await fetchAllPages(bbox, zoom, requestDelayMs)
const deduped = dedupeFeatures(rawFeatures)
console.log(`open-litter-map: fetched ${rawFeatures.length.toLocaleString()} rows, ${deduped.length.toLocaleString()} unique photos/points`)

const clipped = deduped
  .filter((feature) => pointInAnyBoundary(feature, boundaryFeatures))
  .map(normalizeFeature)
  .sort((a, b) => {
    const ad = String(a.properties.datetime ?? '')
    const bd = String(b.properties.datetime ?? '')
    return ad.localeCompare(bd) || Number(a.properties.sourceId) - Number(b.properties.sourceId)
  })

const summary = summarize(clipped)
const pointCollection = {
  type: 'FeatureCollection',
  features: clipped,
  metadata: {
    source: 'OpenLitterMap',
    sourceUrl: SOURCE_MAP_URL,
    sourceApi: API_URL,
    generatedAt: new Date().toISOString(),
    dedication: DEDICATION,
    boundarySource: path.relative(ROOT, boundaryPath),
    boundaryFeatureCount: boundaryFeatures.length,
    bbox,
    requestedZoom: zoom,
    sourceRows: rawFeatures.length,
    uniqueRows: deduped.length,
    clippedRows: clipped.length,
  },
}

const pointStats = await writeJsonAndGzip(path.join(OUTPUT_DIR, 'open_litter_map_pg.geojson'), pointCollection, {
  raw: false,
})

const manifest = {
  source: 'OpenLitterMap',
  sourcePage: SOURCE_MAP_URL,
  sourceApi: API_URL,
  dedication: DEDICATION,
  sourceLicense: 'OpenLitterMap public map data; verify current reuse terms before redistribution.',
  coverage: 'OpenLitterMap points inside the City of Prince George community-boundary union.',
  generatedAt: pointCollection.metadata.generatedAt,
  boundarySource: pointCollection.metadata.boundarySource,
  bbox,
  requestedZoom: zoom,
  rows: clipped.length,
  sourceRows: rawFeatures.length,
  uniqueRows: deduped.length,
  totalLitter: summary.totalLitter,
  pickedUpRecords: summary.pickedUpRecords,
  verifiedRecords: summary.verifiedRecords,
  dateStart: summary.dateStart,
  dateEnd: summary.dateEnd,
  yearStart: summary.yearStart,
  yearEnd: summary.yearEnd,
  categories: summary.categories,
  objects: summary.objects.slice(0, 100),
  materials: summary.materials,
  contributors: summary.contributors,
  years: summary.years,
  months: summary.months,
  geojson: null,
  geojsonGzip: '/data/open-litter-map/open_litter_map_pg.geojson.gz',
  hexGeojson: null,
  hexGeojsonGzip: null,
  hexComputedClientSide: true,
  hexSizeM,
  rawBytes: pointStats.rawBytes,
  gzipBytes: pointStats.gzipBytes,
  hexRawBytes: null,
  hexGzipBytes: null,
  fields: [
    'sourceId',
    'datetime',
    'year',
    'month',
    'categoryNames',
    'objectNames',
    'materialNames',
    'customTags',
    'litterCount',
    'pickedUp',
    'verified',
    'name',
    'team',
  ],
}

await writeJsonAndGzip(path.join(OUTPUT_DIR, 'manifest.json'), manifest)

console.log(
  `open-litter-map: wrote ${clipped.length.toLocaleString()} compressed point records and ${summary.categories.length} categories`,
)

function parseArgs(values) {
  const parsed = {}
  for (let i = 0; i < values.length; i += 1) {
    const arg = values[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = values[i + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = true
    } else {
      parsed[key] = next
      i += 1
    }
  }
  return parsed
}

async function fetchAllPages(bounds, requestedZoom, delayMs) {
  const first = await fetchPage(bounds, requestedZoom, 1)
  const pages = Math.max(1, Number(first.last_page ?? first.meta?.last_page ?? 1))
  const features = [...(first.features ?? [])]
  console.log(`open-litter-map: page 1/${pages}, source total ${Number(first.total ?? features.length).toLocaleString()}`)

  for (let page = 2; page <= pages; page += 1) {
    await delay(delayMs)
    const data = await fetchPage(bounds, requestedZoom, page)
    features.push(...(data.features ?? []))
    console.log(`open-litter-map: page ${page}/${pages}, rows ${features.length.toLocaleString()}`)
  }
  return features
}

async function fetchPage(bounds, requestedZoom, page) {
  const params = new URLSearchParams({
    zoom: String(requestedZoom),
    page: String(page),
  })
  params.set('bbox[left]', String(bounds[0]))
  params.set('bbox[bottom]', String(bounds[1]))
  params.set('bbox[right]', String(bounds[2]))
  params.set('bbox[top]', String(bounds[3]))

  const response = await fetch(`${API_URL}?${params}`, {
    headers: {
      accept: 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      'user-agent': USER_AGENT,
    },
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenLitterMap request failed ${response.status}: ${body.slice(0, 500)}`)
  }
  return response.json()
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function dedupeFeatures(features) {
  const seen = new Set()
  const deduped = []
  for (const feature of features) {
    const id = feature?.properties?.id
    const coordinates = feature?.geometry?.coordinates
    const key = id != null ? String(id) : JSON.stringify(coordinates)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(feature)
  }
  return deduped
}

function pointInAnyBoundary(feature, boundaries) {
  const coordinates = feature?.geometry?.coordinates
  if (!Array.isArray(coordinates) || coordinates.length < 2) return false
  const pt = point(coordinates)
  return boundaries.some((boundaryFeature) => booleanPointInPolygon(pt, boundaryFeature))
}

function normalizeFeature(feature) {
  const properties = feature.properties ?? {}
  const datetime = parseDate(properties.datetime)
  const summary = properties.summary ?? {}
  const keys = summary.keys ?? {}
  const tags = Array.isArray(summary.tags) ? summary.tags : []
  const categoryNames = uniqueSorted(
    tags.map((tag) => keyName(keys.categories, tag.category_id)).filter(Boolean),
  )
  const objectNames = uniqueSorted(tags.map((tag) => keyName(keys.objects, tag.object_id)).filter(Boolean))
  const materialNames = uniqueSorted(
    tags.flatMap((tag) => (Array.isArray(tag.materials) ? tag.materials : []).map((id) => keyName(keys.materials, id))).filter(Boolean),
  )
  const brandNames = uniqueSorted(
    tags.flatMap((tag) => (Array.isArray(tag.brands) ? tag.brands : []).map((id) => keyName(keys.brands, id))).filter(Boolean),
  )
  const customTags = uniqueSorted(
    tags
      .flatMap((tag) => (Array.isArray(tag.custom_tags) ? tag.custom_tags : []).map((id) => keyName(keys.custom_tags, id)))
      .filter(Boolean),
  )
  const litterCount = tags.reduce((sum, tag) => sum + numeric(tag.quantity, 0), 0) || numeric(summary.totals?.litter, 1)

  return {
    type: 'Feature',
    geometry: feature.geometry,
    properties: {
      ...properties,
      sourceId: properties.id,
      datetime: datetime?.toISOString() ?? properties.datetime ?? null,
      year: datetime?.getUTCFullYear() ?? null,
      month: datetime ? `${datetime.getUTCFullYear()}-${String(datetime.getUTCMonth() + 1).padStart(2, '0')}` : null,
      categoryNames,
      objectNames,
      materialNames,
      brandNames,
      customTags,
      litterCount,
      tagCount: tags.length,
      pickedUp: Boolean(properties.picked_up),
      verified: numeric(properties.verified, 0),
    },
  }
}

function summarize(features) {
  const categories = new Map()
  const objects = new Map()
  const materials = new Map()
  const contributors = new Map()
  const years = new Map()
  const months = new Map()
  let totalLitter = 0
  let pickedUpRecords = 0
  let verifiedRecords = 0
  let dateStart = null
  let dateEnd = null

  for (const feature of features) {
    const props = feature.properties
    const count = numeric(props.litterCount, 1)
    totalLitter += count
    if (props.pickedUp) pickedUpRecords += 1
    if (numeric(props.verified, 0) > 0) verifiedRecords += 1

    updateTimeRange(props.datetime)
    if (props.year != null) increment(years, String(props.year), 1, count)
    if (props.month) increment(months, String(props.month), 1, count)
    incrementContributor(contributors, props, count)
    for (const name of props.categoryNames ?? []) increment(categories, name, 1, count)
    for (const name of props.objectNames ?? []) increment(objects, name, 1, count)
    for (const name of props.materialNames ?? []) increment(materials, name, 1, count)
  }

  const yearValues = Array.from(years.keys()).map(Number).filter(Number.isFinite)
  return {
    totalLitter,
    pickedUpRecords,
    verifiedRecords,
    dateStart,
    dateEnd,
    yearStart: yearValues.length ? Math.min(...yearValues) : null,
    yearEnd: yearValues.length ? Math.max(...yearValues) : null,
    categories: sortedSummary(categories),
    objects: sortedSummary(objects),
    materials: sortedSummary(materials),
    contributors: Array.from(contributors.values())
      .sort((a, b) => b.litter - a.litter || b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 50),
    years: sortedSummary(years, 'asc'),
    months: sortedSummary(months, 'asc'),
  }

  function updateTimeRange(value) {
    if (!value) return
    const parsed = parseDate(value)
    if (!parsed) return
    const iso = parsed.toISOString()
    if (!dateStart || iso < dateStart) dateStart = iso
    if (!dateEnd || iso > dateEnd) dateEnd = iso
  }
}

function incrementContributor(map, props, litter) {
  const name = props.name || props.username || props.team || props.flag || 'Unknown'
  const key = `${name}|${props.username ?? ''}`
  const current = map.get(key) ?? {
    name,
    username: props.username ?? null,
    team: props.team ?? null,
    flag: props.flag ?? null,
    count: 0,
    litter: 0,
  }
  if (!current.team && props.team) current.team = props.team
  if (!current.flag && props.flag) current.flag = props.flag
  current.count += 1
  current.litter += litter
  map.set(key, current)
}

function increment(map, name, records = 1, litter = 0) {
  const current = map.get(name) ?? { name, count: 0, litter: 0 }
  current.count += records
  current.litter += litter
  map.set(name, current)
}

function sortedSummary(map, direction = 'desc') {
  const values = Array.from(map.values())
  if (direction === 'asc') return values.sort((a, b) => a.name.localeCompare(b.name))
  return values.sort((a, b) => b.litter - a.litter || b.count - a.count || a.name.localeCompare(b.name))
}

function boundsForFeatures(features) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity]
  for (const feature of features) scanCoordinates(feature.geometry.coordinates, bounds)
  return bounds
}

function scanCoordinates(coordinates, bounds) {
  if (!Array.isArray(coordinates)) return
  if (typeof coordinates[0] === 'number') {
    bounds[0] = Math.min(bounds[0], coordinates[0])
    bounds[1] = Math.min(bounds[1], coordinates[1])
    bounds[2] = Math.max(bounds[2], coordinates[0])
    bounds[3] = Math.max(bounds[3], coordinates[1])
    return
  }
  for (const item of coordinates) scanCoordinates(item, bounds)
}

function keyName(values, id) {
  if (id == null || !values) return null
  return values[String(id)] ?? values[id] ?? null
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort((a, b) => String(a).localeCompare(String(b)))
}

function parseDate(value) {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function numeric(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

async function writeJsonAndGzip(filePath, value, options = {}) {
  const raw = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  const gzipped = gzipSync(raw, { level: 9 })
  if (options.raw !== false) await writeFile(filePath, raw)
  await writeFile(`${filePath}.gz`, gzipped)
  return {
    rawBytes: raw.length,
    gzipBytes: gzipped.length,
  }
}
