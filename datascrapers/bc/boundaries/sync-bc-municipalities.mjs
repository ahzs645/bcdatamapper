import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import {
  MAPSHAPER_VERSION,
  simplifySharedPolygonTopology,
} from '../../lib/mapshaper-topology.mjs'

const TYPE_NAME = 'WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_MUNICIPALITIES_SP'
const WFS_BASE = 'https://openmaps.gov.bc.ca/geo/pub'
const OUTPUT_PATH = 'datascrapers/bc/boundaries/output/BC/municipalities.geojson'
const SOURCE_CRS = 'EPSG:4326'
const WORKING_CRS = 'EPSG:3005'
const OUTPUT_CRS = 'EPSG:4326'
const DEFAULT_TOLERANCE_METRES = 3
const COORDINATE_PRECISION = 6
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const VENDOR_ROOT = join(SCRIPT_DIR, '..', '..', '..')

function parseToleranceMetres() {
  const arg = process.argv.find((value) => value.startsWith('--tolerance-metres='))
  const raw = arg ? arg.split('=')[1] : process.env.MUNICIPALITY_SIMPLIFY_TOLERANCE_METRES
  if (!raw) return DEFAULT_TOLERANCE_METRES

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid municipality simplification tolerance in metres: ${raw}`)
  }
  return parsed
}

function getWfsUrl() {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: `pub:${TYPE_NAME}`,
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
  })

  return `${WFS_BASE}/${TYPE_NAME}/ows?${params.toString()}`
}

function countPositions(geometry) {
  if (!geometry) return 0
  let count = 0

  function walk(coordinates) {
    if (!Array.isArray(coordinates)) return
    if (typeof coordinates[0] === 'number') {
      count += 1
      return
    }
    for (const entry of coordinates) walk(entry)
  }

  walk(geometry.coordinates)
  return count
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
  if (!feature.geometry || (feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon')) {
    return null
  }

  const properties = feature.properties ?? {}
  const code = String(properties.LGL_ADMIN_AREA_ID ?? properties.OBJECTID ?? feature.id ?? '').trim()
  if (!code) return null

  const name = String(properties.ADMIN_AREA_NAME ?? code).trim() || code
  const boundaryType = String(properties.ADMIN_AREA_BOUNDARY_TYPE ?? '').trim()

  return {
    type: 'Feature',
    id: code,
    properties: {
      boundaryCode: code,
      boundaryName: name,
      LGL_ADMIN_AREA_ID: properties.LGL_ADMIN_AREA_ID ?? null,
      ADMIN_AREA_NAME: name,
      ADMIN_AREA_ABBREVIATION: properties.ADMIN_AREA_ABBREVIATION ?? null,
      ADMIN_AREA_BOUNDARY_TYPE: boundaryType || null,
      FEATURE_AREA_SQM: properties.FEATURE_AREA_SQM ?? null,
      OBJECTID: properties.OBJECTID ?? null,
    },
    geometry: {
      ...feature.geometry,
      coordinates: roundCoordinates(feature.geometry.coordinates),
    },
  }
}

function normalizeCollection(collection) {
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('WFS response was not a GeoJSON FeatureCollection')
  }

  const features = collection.features.map(normalizeFeature).filter(Boolean)
  if (features.length === 0) {
    throw new Error('WFS response contained no municipality features')
  }

  return {
    type: 'FeatureCollection',
    name: 'municipalities',
    metadata: {
      source: 'BC Geographic Warehouse',
      sourceLayer: TYPE_NAME,
      coverage: 'BC-wide legally defined municipality boundaries',
      sourceCrs: SOURCE_CRS,
      workingCrs: WORKING_CRS,
      outputCrs: OUTPUT_CRS,
      simplification: 'Mapshaper shared-topology Ramer-Douglas-Peucker',
      simplificationToleranceMetres: parseToleranceMetres(),
      topologyPreserving: true,
      mapshaperVersion: MAPSHAPER_VERSION,
      coordinatePrecision: COORDINATE_PRECISION,
    },
    features,
  }
}

async function fetchMunicipalities() {
  const response = await fetch(getWfsUrl())
  if (!response.ok) {
    throw new Error(`Failed to fetch BC municipalities: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

const toleranceMetres = parseToleranceMetres()
const raw = await fetchMunicipalities()
const rawVertices = raw.features.reduce((sum, feature) => sum + countPositions(feature.geometry), 0)
const source = simplifySharedPolygonTopology(raw, {
  toleranceMetres,
  sourceCrs: SOURCE_CRS,
  workingCrs: WORKING_CRS,
  outputCrs: OUTPUT_CRS,
  coordinatePrecision: COORDINATE_PRECISION,
  tempPrefix: 'bc-municipalities-',
})
const output = normalizeCollection(source)
output.metadata.simplificationToleranceMetres = toleranceMetres

const outputVertices = output.features.reduce((sum, feature) => sum + countPositions(feature.geometry), 0)
const payload = `${JSON.stringify(output)}\n`
const outputPath = join(VENDOR_ROOT, OUTPUT_PATH)

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, payload)

console.log(JSON.stringify({
  output: OUTPUT_PATH,
  features: output.features.length,
  toleranceMetres,
  rawVertices,
  outputVertices,
  bytes: Buffer.byteLength(payload),
  gzipBytes: gzipSync(payload).length,
}))
