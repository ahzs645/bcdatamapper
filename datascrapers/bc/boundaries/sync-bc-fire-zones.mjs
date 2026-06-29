import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import simplify from '@turf/simplify'

const SOURCE_URL = 'https://services6.arcgis.com/ubm4tcTYICKBpist/arcgis/rest/services/British_Columbia_Fire_Zone_Boundaries/FeatureServer/0/query'
const OUTPUT_PATH = 'datascrapers/bc/boundaries/output/BCWildfire/fire_zones.geojson'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const VENDOR_ROOT = join(SCRIPT_DIR, '..', '..', '..')
const DEFAULT_TOLERANCE = 0.00025
const COORDINATE_PRECISION = 6

function parseTolerance() {
  const arg = process.argv.find((value) => value.startsWith('--tolerance='))
  const raw = arg ? arg.split('=')[1] : process.env.FIRE_ZONE_SIMPLIFY_TOLERANCE
  if (!raw) return DEFAULT_TOLERANCE

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid fire-zone simplification tolerance: ${raw}`)
  }
  return parsed
}

function countPositions(geometry) {
  if (!geometry) return 0
  if (geometry.type === 'Polygon') {
    return geometry.coordinates.reduce((sum, ring) => sum + ring.length, 0)
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.reduce(
      (sum, polygon) => sum + polygon.reduce((inner, ring) => inner + ring.length, 0),
      0,
    )
  }
  return 0
}

function roundNumber(value) {
  return Number(value.toFixed(COORDINATE_PRECISION))
}

function roundCoordinates(value) {
  if (typeof value[0] === 'number') {
    return [roundNumber(value[0]), roundNumber(value[1])]
  }
  return value.map((entry) => roundCoordinates(entry))
}

function normalizeFeature(feature) {
  const properties = feature.properties ?? {}
  const code = String(properties.FIRE_ZONE_CODE ?? properties.OBJECTID ?? '').trim()
  if (!code) {
    throw new Error(`Missing FIRE_ZONE_CODE for feature ${feature.id ?? '(unknown)'}`)
  }

  const name = String(properties.FIRE_ZONE ?? code).trim() || code
  const fireCentre = String(properties.FIRE_CENTRE ?? '').trim()
  const headquarters = String(properties.HEADQUARTERS ?? '').trim()

  return {
    type: 'Feature',
    id: code,
    geometry: feature.geometry,
    properties: {
      boundaryCode: code,
      boundaryName: name,
      FIRE_ZONE_CODE: code,
      FIRE_ZONE: name,
      FIRE_CENTRE: fireCentre,
      HEADQUARTERS: headquarters,
      OBJECTID: properties.OBJECTID ?? feature.id ?? null,
    },
  }
}

function normalizeCollection(collection) {
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('ArcGIS response was not a GeoJSON FeatureCollection')
  }

  const features = collection.features.map(normalizeFeature)
  if (features.length === 0) {
    throw new Error('ArcGIS response contained no fire-zone features')
  }

  return {
    type: 'FeatureCollection',
    features,
  }
}

function roundGeometry(feature) {
  if (!feature.geometry) return feature
  return {
    ...feature,
    geometry: {
      ...feature.geometry,
      coordinates: roundCoordinates(feature.geometry.coordinates),
    },
  }
}

async function fetchFireZones() {
  const url = new URL(SOURCE_URL)
  url.searchParams.set('where', '1=1')
  url.searchParams.set('outFields', 'OBJECTID,FIRE_CENTRE,FIRE_ZONE,HEADQUARTERS,FIRE_ZONE_CODE')
  url.searchParams.set('returnGeometry', 'true')
  url.searchParams.set('outSR', '4326')
  url.searchParams.set('f', 'geojson')

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch BC fire zones: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

const tolerance = parseTolerance()
const raw = normalizeCollection(await fetchFireZones())
const rawVertices = raw.features.reduce((sum, feature) => sum + countPositions(feature.geometry), 0)
const simplified = simplify(raw, { tolerance, highQuality: true, mutate: false })
const output = {
  type: 'FeatureCollection',
  features: simplified.features.map(roundGeometry),
}
const outputVertices = output.features.reduce((sum, feature) => sum + countPositions(feature.geometry), 0)
const payload = `${JSON.stringify(output)}\n`
const outputPath = join(VENDOR_ROOT, OUTPUT_PATH)

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, payload)

console.log(JSON.stringify({
  output: OUTPUT_PATH,
  features: output.features.length,
  tolerance,
  rawVertices,
  outputVertices,
  bytes: Buffer.byteLength(payload),
  gzipBytes: gzipSync(payload).length,
}))
