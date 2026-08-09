import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { area } from '@turf/turf'
import {
  MAPSHAPER_VERSION,
  simplifyPolygonTopology,
  TOPOLOGY_PROFILES,
} from '../../lib/mapshaper-topology.mjs'

const LAYER = 'WHSE_WATER_MANAGEMENT.SSL_SNOW_SURVEY_BASIN_AREA_SP'
const SOURCE_URL = `https://openmaps.gov.bc.ca/geo/pub/${LAYER}/ows`
const CATALOGUE_URL = 'https://catalogue.data.gov.bc.ca/dataset/9ec01cdb-7085-44fe-b059-9fe5aefb7497'
const LICENCE_URL = 'https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61'
const OUTPUT_PATH = 'datascrapers/bc/boundaries/output/BCSnowSurvey/snow_survey_admin_basins.geojson'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const VENDOR_ROOT = join(SCRIPT_DIR, '..', '..', '..')
const SOURCE_CRS = 'EPSG:3005'
const OUTPUT_CRS = 'EPSG:4326'
const DEFAULT_TOLERANCE_METRES = 25
const COORDINATE_PRECISION = 6
const EXPECTED_FEATURES = 23

function parseToleranceMetres() {
  const argument = process.argv.find((value) => value.startsWith('--tolerance-metres='))
  const raw = argument?.split('=')[1] ?? process.env.SNOW_SURVEY_BASIN_SIMPLIFY_TOLERANCE_METRES
  if (!raw) return DEFAULT_TOLERANCE_METRES

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid snow-survey basin simplification tolerance in metres: ${raw}`)
  }
  return parsed
}

function slugify(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function countPositions(geometry) {
  if (geometry?.type === 'Polygon') {
    return geometry.coordinates.reduce((sum, ring) => sum + ring.length, 0)
  }
  if (geometry?.type === 'MultiPolygon') {
    return geometry.coordinates.reduce(
      (sum, polygon) => sum + polygon.reduce((inner, ring) => inner + ring.length, 0),
      0,
    )
  }
  return 0
}

function normalizeFeature(feature) {
  const properties = feature.properties ?? {}
  const basinId = String(properties.BASIN_ID ?? '').trim()
  const basinName = String(properties.BASIN_NAME ?? '').trim()
  if (!basinId || !basinName) {
    throw new Error(`Missing basin identifier or name for feature ${feature.id ?? '(unknown)'}`)
  }
  if (!feature.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) {
    throw new Error(`Snow Survey basin ${basinId} does not contain polygon geometry`)
  }

  const slug = slugify(basinName)
  return {
    type: 'Feature',
    id: `snow-survey-basin:${basinId}`,
    properties: {
      boundaryCode: basinId,
      boundaryName: basinName,
      boundaryFamily: 'BC Snow Survey Administrative Basins',
      basin_id: basinId,
      basin_name: basinName,
      slug,
      compact_slug: slug.replaceAll('-', ''),
      feature_code: properties.FEATURE_CODE ?? null,
      source_object_id: properties.OBJECTID ?? null,
      source_area_sq_m: properties.FEATURE_AREA_SQM ?? null,
      source_length_m: properties.FEATURE_LENGTH_M ?? null,
    },
    geometry: feature.geometry,
  }
}

function normalizeCollection(collection) {
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('OpenMaps response was not a GeoJSON FeatureCollection')
  }
  const features = collection.features
    .map(normalizeFeature)
    .sort((a, b) => a.properties.basin_id.localeCompare(b.properties.basin_id, undefined, { numeric: true }))
  if (features.length !== EXPECTED_FEATURES) {
    throw new Error(`Expected ${EXPECTED_FEATURES} Snow Survey basins; received ${features.length}`)
  }
  for (const key of ['basin_id', 'basin_name', 'slug']) {
    if (new Set(features.map((feature) => feature.properties[key])).size !== features.length) {
      throw new Error(`Snow Survey basin ${key} values are not unique`)
    }
  }
  return { type: 'FeatureCollection', features }
}

function wfsUrl() {
  const url = new URL(SOURCE_URL)
  url.search = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: LAYER,
    outputFormat: 'application/json',
    srsName: SOURCE_CRS,
  })
  return url.href
}

async function fetchBasins() {
  const response = await fetch(wfsUrl(), {
    signal: AbortSignal.timeout(120000),
    headers: { 'user-agent': 'bcdatamapper snow-survey-boundaries sync/1.0' },
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch Snow Survey Administrative Basins: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

function areaValidation(features) {
  const deviations = features.map((feature) => {
    const sourceArea = Number(feature.properties.source_area_sq_m)
    if (!Number.isFinite(sourceArea) || sourceArea <= 0) return null
    return Math.abs(area(feature) - sourceArea) / sourceArea
  }).filter((value) => value != null)
  return {
    comparedFeatures: deviations.length,
    maximumRelativeDeviation: Math.max(...deviations),
    meanRelativeDeviation: deviations.reduce((sum, value) => sum + value, 0) / deviations.length,
  }
}

const toleranceMetres = parseToleranceMetres()
const raw = normalizeCollection(await fetchBasins())
const rawVertices = raw.features.reduce((sum, feature) => sum + countPositions(feature.geometry), 0)
const simplified = simplifyPolygonTopology(raw, {
  toleranceMetres,
  topologyProfile: TOPOLOGY_PROFILES.PARTITION,
  sourceCrs: SOURCE_CRS,
  workingCrs: SOURCE_CRS,
  outputCrs: OUTPUT_CRS,
  coordinatePrecision: COORDINATE_PRECISION,
  tempPrefix: 'bc-snow-survey-basins-',
})
const features = simplified.features.sort((a, b) => (
  a.properties.basin_id.localeCompare(b.properties.basin_id, undefined, { numeric: true })
))
const outputVertices = features.reduce((sum, feature) => sum + countPositions(feature.geometry), 0)
const outputAreaValidation = areaValidation(features)
if (outputAreaValidation.maximumRelativeDeviation > 0.005) {
  throw new Error(`Snow Survey basin area deviation exceeded 0.5%: ${outputAreaValidation.maximumRelativeDeviation}`)
}
const output = {
  type: 'FeatureCollection',
  name: 'BC Snow Survey Administrative Basin Areas',
  metadata: {
    ...simplified.metadata,
    boundaryDatasetId: 'bc-snow-survey-admin-basins',
    boundaryFamilyId: 'BCSnowSurvey',
    source: 'BC Geographic Warehouse Snow Survey Administrative Basin Areas',
    sourceLayer: LAYER,
    sourceUrl: wfsUrl(),
    catalogueUrl: CATALOGUE_URL,
    licence: 'Open Government Licence - British Columbia',
    licenceUrl: LICENCE_URL,
    purpose: 'Snow Survey Network station naming and snow-program reporting areas',
    lineageStatement: 'May 15, 2019 the linework for the boundaries was updated.',
    derivationAssessment: 'The official metadata does not identify an existing BC Data Mapper boundary family as a parent. Preserve this published program-specific partition rather than deriving it from FWA, drainage, health, or administrative boundaries.',
    hydrologicContext: 'Some basin edges closely follow hydrologic units, but the complete 23-basin partition is not equivalent to the existing FWA or BC Drainage families.',
    nativeCrs: SOURCE_CRS,
    outputCrs: OUTPUT_CRS,
    simplificationToleranceMetres: toleranceMetres,
    topologyPreserving: true,
    mapshaperVersion: MAPSHAPER_VERSION,
    coordinatePrecision: COORDINATE_PRECISION,
    rawVertices,
    outputVertices,
    areaValidation: outputAreaValidation,
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
  toleranceMetres,
  rawVertices,
  outputVertices,
  bytes: Buffer.byteLength(payload),
  gzipBytes: gzipSync(payload).length,
  areaValidation: output.metadata.areaValidation,
}))
