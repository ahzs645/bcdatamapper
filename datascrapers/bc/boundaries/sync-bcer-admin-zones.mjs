import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import {
  MAPSHAPER_VERSION,
  simplifyPolygonTopology,
  TOPOLOGY_PROFILES,
} from '../../lib/mapshaper-topology.mjs'

const ITEM_URL = 'https://data-bc-er.opendata.arcgis.com/datasets/032cac78a0264d23b7461ba2f8e1a8d7_1'
const SOURCE_URL = 'https://geoweb-ags.bc-er.ca/arcgis/rest/services/ADMIN/ADMINISTRATIVE_ZONES_PY/MapServer/1/query'
const LICENSE_URL = 'https://www.bc-er.ca/files/gis/BCER-Open-Data-Licence.pdf'
const OUTPUT_PATH = 'datascrapers/bc/boundaries/output/BCER/admin_zones.geojson'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const VENDOR_ROOT = join(SCRIPT_DIR, '..', '..', '..')
const SOURCE_CRS = 'EPSG:3005'
const OUTPUT_CRS = 'EPSG:4326'
const DEFAULT_TOLERANCE_METRES = 50
const COORDINATE_PRECISION = 6

function parseTolerance() {
  const arg = process.argv.find((value) => value.startsWith('--tolerance='))
  const raw = arg ? arg.split('=')[1] : process.env.BCER_ADMIN_ZONE_SIMPLIFY_TOLERANCE
  if (!raw) return DEFAULT_TOLERANCE_METRES

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid BCER admin-zone simplification tolerance in metres: ${raw}`)
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

function zoneCode(name) {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
}

function normalizeFeature(feature) {
  if (!feature.geometry || (feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon')) {
    throw new Error(`BCER feature ${feature.id ?? '(unknown)'} does not contain polygon geometry`)
  }

  const properties = feature.properties ?? {}
  const name = String(properties.NAME ?? '').trim()
  const code = zoneCode(name)
  if (!code) {
    throw new Error(`Missing administrative zone name for feature ${feature.id ?? '(unknown)'}`)
  }

  return {
    type: 'Feature',
    id: code,
    geometry: feature.geometry,
    properties: {
      boundaryCode: code,
      boundaryName: name,
      NAME: name,
      OBJECTID: properties.OBJECTID ?? feature.id ?? null,
      sourceShapeAreaSqM: properties['SHAPE.AREA'] ?? null,
    },
  }
}

function normalizeCollection(collection) {
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('BCER ArcGIS response was not a GeoJSON FeatureCollection')
  }

  const features = collection.features
    .map(normalizeFeature)
    .sort((a, b) => a.properties.boundaryName.localeCompare(b.properties.boundaryName))

  if (features.length === 0) {
    throw new Error('BCER ArcGIS response contained no administrative zones')
  }

  const codes = new Set(features.map((feature) => feature.properties.boundaryCode))
  if (codes.size !== features.length) {
    throw new Error('BCER administrative zone names did not produce unique boundary codes')
  }

  return {
    type: 'FeatureCollection',
    features,
  }
}

async function fetchAdminZones() {
  const url = new URL(SOURCE_URL)
  url.searchParams.set('where', '1=1')
  url.searchParams.set('outFields', 'OBJECTID,NAME,SHAPE.AREA')
  url.searchParams.set('returnGeometry', 'true')
  // Fetch in the service's native projected CRS so the simplification interval
  // is expressed in metres. Mapshaper reprojects the shared-topology result to
  // WGS84 after simplification.
  url.searchParams.set('outSR', '3005')
  url.searchParams.set('f', 'geojson')

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch BCER administrative zones: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

function simplifySharedTopology(raw, toleranceMetres) {
  const simplified = simplifyPolygonTopology(raw, {
    toleranceMetres,
    topologyProfile: TOPOLOGY_PROFILES.PARTITION,
    sourceCrs: SOURCE_CRS,
    workingCrs: SOURCE_CRS,
    outputCrs: OUTPUT_CRS,
    coordinatePrecision: COORDINATE_PRECISION,
    tempPrefix: 'bcer-admin-zones-',
  })
  return {
    type: 'FeatureCollection',
    metadata: simplified.metadata,
    features: simplified.features.sort(
      (a, b) => String(a.properties?.boundaryName ?? '').localeCompare(String(b.properties?.boundaryName ?? '')),
    ),
  }
}

const toleranceMetres = parseTolerance()
const raw = normalizeCollection(await fetchAdminZones())
const rawVertices = raw.features.reduce((sum, feature) => sum + countPositions(feature.geometry), 0)
const simplified = simplifySharedTopology(raw, toleranceMetres)
const features = simplified.features
const outputVertices = features.reduce((sum, feature) => sum + countPositions(feature.geometry), 0)
const output = {
  type: 'FeatureCollection',
  name: 'BCER administrative zones',
  metadata: {
    ...simplified.metadata,
    source: 'British Columbia Energy Regulator',
    itemUrl: ITEM_URL,
    serviceUrl: SOURCE_URL,
    licence: 'BC Energy Regulator Open Data Licence',
    licenceUrl: LICENSE_URL,
    coverage: 'BCER application-processing regions in British Columbia',
    nativeCrs: SOURCE_CRS,
    outputCrs: OUTPUT_CRS,
    simplification: 'Shared-topology Ramer-Douglas-Peucker',
    simplificationToleranceMetres: toleranceMetres,
    topologyPreserving: true,
    mapshaperVersion: MAPSHAPER_VERSION,
    coordinatePrecision: COORDINATE_PRECISION,
    rawVertices,
    outputVertices,
  },
  features,
}
const payload = `${JSON.stringify(output)}\n`
const outputPath = join(VENDOR_ROOT, OUTPUT_PATH)

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, payload)

console.log(JSON.stringify({
  output: OUTPUT_PATH,
  features: output.features.length,
  names: output.features.map((feature) => feature.properties.boundaryName),
  toleranceMetres,
  topologyPreserving: true,
  mapshaperVersion: MAPSHAPER_VERSION,
  rawVertices,
  outputVertices,
  bytes: Buffer.byteLength(payload),
  gzipBytes: gzipSync(payload).length,
}))
