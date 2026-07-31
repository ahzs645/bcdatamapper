import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import {
  MAPSHAPER_VERSION,
  simplifyPolygonTopology,
  TOPOLOGY_PROFILES,
} from '../../lib/mapshaper-topology.mjs'

const TYPE_NAME = 'WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_REGIONAL_DISTRICTS_SP'
const WFS_BASE = 'https://openmaps.gov.bc.ca/geo/pub'
const OUTPUT_PATH = 'datascrapers/bc/boundaries/output/BC/regional_districts.geojson'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const VENDOR_ROOT = join(SCRIPT_DIR, '..', '..', '..')
const SOURCE_CRS = 'EPSG:4326'
const WORKING_CRS = 'EPSG:3005'
const OUTPUT_CRS = 'EPSG:4326'
const DEFAULT_TOLERANCE_METRES = 25
const COORDINATE_PRECISION = 7

function parseToleranceMetres() {
  const arg = process.argv.find((value) => value.startsWith('--tolerance-metres='))
  const raw = arg ? arg.split('=')[1] : process.env.REGIONAL_DISTRICT_SIMPLIFY_TOLERANCE_METRES
  if (!raw) return DEFAULT_TOLERANCE_METRES
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid regional-district simplification tolerance in metres: ${raw}`)
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
    srsName: SOURCE_CRS,
  })
  return `${WFS_BASE}/${TYPE_NAME}/ows?${params.toString()}`
}

function normalizeFeature(feature) {
  if (!feature.geometry || (feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon')) {
    return null
  }
  const properties = feature.properties ?? {}
  const code = String(properties.ADMIN_AREA_ABBREVIATION ?? properties.LGL_ADMIN_AREA_ID ?? '').trim()
  if (!code) return null
  const name = String(properties.ADMIN_AREA_NAME ?? code).trim() || code
  return {
    type: 'Feature',
    id: code,
    geometry: feature.geometry,
    properties: {
      LGL_ADMIN_AREA_ID: properties.LGL_ADMIN_AREA_ID ?? null,
      ADMIN_AREA_NAME: name,
      ADMIN_AREA_ABBREVIATION: properties.ADMIN_AREA_ABBREVIATION ?? null,
      ADMIN_AREA_BOUNDARY_TYPE: properties.ADMIN_AREA_BOUNDARY_TYPE ?? null,
      FEATURE_AREA_SQM: properties.FEATURE_AREA_SQM ?? null,
      OBJECTID: properties.OBJECTID ?? feature.id ?? null,
      boundaryCode: code,
      boundaryName: name,
    },
  }
}

const response = await fetch(getWfsUrl())
if (!response.ok) {
  throw new Error(`Failed to fetch BC regional districts: ${response.status} ${response.statusText}`)
}
const source = await response.json()
if (source.type !== 'FeatureCollection' || !Array.isArray(source.features)) {
  throw new Error('Regional-district WFS response was not a GeoJSON FeatureCollection')
}
const features = source.features.map(normalizeFeature).filter(Boolean)
const toleranceMetres = parseToleranceMetres()
const simplified = simplifyPolygonTopology({ type: 'FeatureCollection', features }, {
  toleranceMetres,
  topologyProfile: TOPOLOGY_PROFILES.PARTITION,
  sourceCrs: SOURCE_CRS,
  workingCrs: WORKING_CRS,
  outputCrs: OUTPUT_CRS,
  coordinatePrecision: COORDINATE_PRECISION,
  tempPrefix: 'bc-regional-districts-',
})
const output = {
  type: 'FeatureCollection',
  name: 'regional_districts',
  metadata: {
    ...simplified.metadata,
    source: 'BC Geographic Warehouse',
    sourceLayer: TYPE_NAME,
    coverage: 'BC-wide regional district boundaries',
    sourceCrs: SOURCE_CRS,
    workingCrs: WORKING_CRS,
    outputCrs: OUTPUT_CRS,
    simplification: 'Mapshaper shared-topology Ramer-Douglas-Peucker',
    simplificationToleranceMetres: toleranceMetres,
    topologyPreserving: true,
    mapshaperVersion: MAPSHAPER_VERSION,
    coordinatePrecision: COORDINATE_PRECISION,
  },
  features: simplified.features.sort((a, b) => (
    String(a.properties?.ADMIN_AREA_NAME ?? '').localeCompare(String(b.properties?.ADMIN_AREA_NAME ?? ''))
  )),
}
const payload = `${JSON.stringify(output)}\n`
const outputPath = join(VENDOR_ROOT, OUTPUT_PATH)
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, payload)
console.log(JSON.stringify({
  output: OUTPUT_PATH,
  features: output.features.length,
  toleranceMetres,
  bytes: Buffer.byteLength(payload),
  gzipBytes: gzipSync(payload).length,
}))
