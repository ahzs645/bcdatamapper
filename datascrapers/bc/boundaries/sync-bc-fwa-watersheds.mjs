import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bboxClip from '@turf/bbox-clip'
import {
  MAPSHAPER_VERSION,
  simplifyPolygonTopology,
  TOPOLOGY_PROFILES,
} from '../../lib/mapshaper-topology.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output', 'BCFWA')
const WFS_BASE = 'https://openmaps.gov.bc.ca/geo/pub'
const PG_REGION_BBOX = [-125, 52.5, -120, 55.5]
const SOURCE_CRS = 'EPSG:4326'
const WORKING_CRS = 'EPSG:3005'
const OUTPUT_CRS = 'EPSG:4326'
const COORDINATE_PRECISION = 6

const LAYERS = [
  {
    id: 'major_watersheds',
    typeName: 'WHSE_BASEMAPPING.BC_MAJOR_WATERSHEDS',
    sourceLayer: 'WHSE_BASEMAPPING.BC_MAJOR_WATERSHEDS',
    codeField: 'MAJOR_WATERSHED_CODE',
    nameField: 'MAJOR_WATERSHED_SYSTEM',
    keepFields: ['OBJECTID', 'MAJOR_WATERSHED_CODE', 'MAJOR_WATERSHED_SYSTEM', 'FEATURE_AREA_SQM'],
    toleranceMetres: 500,
  },
  {
    id: 'watershed_groups',
    typeName: 'WHSE_BASEMAPPING.FWA_WATERSHED_GROUPS_POLY',
    sourceLayer: 'WHSE_BASEMAPPING.FWA_WATERSHED_GROUPS_POLY',
    codeField: 'WATERSHED_GROUP_CODE',
    nameField: 'WATERSHED_GROUP_NAME',
    keepFields: ['OBJECTID', 'WATERSHED_GROUP_ID', 'WATERSHED_GROUP_CODE', 'WATERSHED_GROUP_NAME', 'AREA_HA'],
    toleranceMetres: 350,
  },
  {
    id: 'assessment_watersheds',
    typeName: 'WHSE_BASEMAPPING.FWA_ASSESSMENT_WATERSHEDS_POLY',
    sourceLayer: 'WHSE_BASEMAPPING.FWA_ASSESSMENT_WATERSHEDS_POLY',
    codeField: 'WATERSHED_FEATURE_ID',
    nameField: 'GNIS_NAME_1',
    keepFields: [
      'OBJECTID',
      'WATERSHED_FEATURE_ID',
      'WATERSHED_GROUP_ID',
      'WATERSHED_GROUP_CODE',
      'GNIS_NAME_1',
      'GNIS_NAME_2',
      'GNIS_NAME_3',
      'FWA_WATERSHED_CODE',
      'LOCAL_WATERSHED_CODE',
      'AREA_HA',
    ],
    toleranceMetres: 150,
  },
]

function getWfsUrl(typeName) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '1.0.0',
    request: 'GetFeature',
    typeName: `pub:${typeName}`,
    outputFormat: 'json',
    srsName: 'EPSG:4326',
    bbox: `${PG_REGION_BBOX.join(',')},EPSG:4326`,
  })

  return `${WFS_BASE}/${typeName}/ows?${params.toString()}`
}

function pickProperties(properties, keepFields, codeField, nameField, sourceLayer) {
  const next = {
    sourceLayer,
    boundaryCode: String(properties[codeField] ?? properties.OBJECTID ?? '').trim(),
    boundaryName: String(properties[nameField] ?? properties.GNIS_NAME_2 ?? properties.GNIS_NAME_3 ?? '').trim(),
  }

  for (const field of keepFields) {
    if (properties[field] !== undefined && properties[field] !== null) {
      next[field] = properties[field]
    }
  }

  if (!next.boundaryName) {
    next.boundaryName = next.boundaryCode
  }

  return next
}

function isUsableRing(ring) {
  return Array.isArray(ring) &&
    ring.length >= 4 &&
    ring.every((position) => (
      Array.isArray(position) &&
      position.length >= 2 &&
      Number.isFinite(position[0]) &&
      Number.isFinite(position[1])
    ))
}

function cleanPolygonCoordinates(polygon) {
  if (!Array.isArray(polygon) || !isUsableRing(polygon[0])) {
    return null
  }

  return [
    polygon[0],
    ...polygon.slice(1).filter(isUsableRing),
  ]
}

function cleanPolygonGeometry(geometry) {
  if (!geometry) return null

  if (geometry.type === 'Polygon') {
    const coordinates = cleanPolygonCoordinates(geometry.coordinates)
    return coordinates ? { ...geometry, coordinates } : null
  }

  if (geometry.type === 'MultiPolygon') {
    const coordinates = Array.isArray(geometry.coordinates)
      ? geometry.coordinates
        .map(cleanPolygonCoordinates)
        .filter((polygon) => polygon !== null)
      : []
    return coordinates.length > 0 ? { ...geometry, coordinates } : null
  }

  return null
}

function normalizeFeature(feature, layer) {
  if (!feature.geometry || (feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon')) {
    return null
  }

  let clipped
  try {
    clipped = bboxClip(feature, PG_REGION_BBOX)
  } catch {
    return null
  }

  const clippedGeometry = cleanPolygonGeometry(clipped.geometry)
  if (!clippedGeometry) return null
  clipped.geometry = clippedGeometry

  return {
    type: 'Feature',
    id: feature.id,
    properties: pickProperties(feature.properties ?? {}, layer.keepFields, layer.codeField, layer.nameField, layer.sourceLayer),
    geometry: clippedGeometry,
  }
}

async function syncLayer(layer) {
  const response = await fetch(getWfsUrl(layer.typeName))
  if (!response.ok) {
    throw new Error(`Failed to fetch ${layer.typeName}: ${response.status}`)
  }

  const source = await response.json()
  const normalizedFeatures = source.features
    .map((feature) => normalizeFeature(feature, layer))
    .filter((feature) => feature && feature.properties.boundaryCode)
  const simplified = simplifyPolygonTopology({
    type: 'FeatureCollection',
    features: normalizedFeatures,
  }, {
    toleranceMetres: layer.toleranceMetres,
    topologyProfile: TOPOLOGY_PROFILES.PARTITION,
    sourceCrs: SOURCE_CRS,
    workingCrs: WORKING_CRS,
    outputCrs: OUTPUT_CRS,
    coordinatePrecision: COORDINATE_PRECISION,
    tempPrefix: `bc-fwa-${layer.id}-`,
  })
  const features = simplified.features

  const collection = {
    type: 'FeatureCollection',
    name: layer.id,
    metadata: {
      ...simplified.metadata,
      source: 'BC Freshwater Atlas / BC Geographic Warehouse',
      sourceLayer: layer.sourceLayer,
      bbox: PG_REGION_BBOX,
      clippedTo: 'Prince George regional viewport',
      sourceCrs: SOURCE_CRS,
      workingCrs: WORKING_CRS,
      outputCrs: OUTPUT_CRS,
      simplification: 'Mapshaper shared-topology Ramer-Douglas-Peucker',
      simplificationToleranceMetres: layer.toleranceMetres,
      topologyPreserving: true,
      mapshaperVersion: MAPSHAPER_VERSION,
      coordinatePrecision: COORDINATE_PRECISION,
    },
    features,
  }

  await writeFile(`${OUTPUT_DIR}/${layer.id}.geojson`, `${JSON.stringify(collection)}\n`)
  console.log(`${layer.id}: wrote ${features.length} features`)
}

const requestedLayerId = process.argv
  .find((argument) => argument.startsWith('--layer='))
  ?.slice('--layer='.length)
const selectedLayers = requestedLayerId
  ? LAYERS.filter((layer) => layer.id === requestedLayerId)
  : LAYERS

if (requestedLayerId && selectedLayers.length === 0) {
  throw new Error(`Unknown FWA layer "${requestedLayerId}"`)
}

await mkdir(OUTPUT_DIR, { recursive: true })
for (const layer of selectedLayers) {
  await syncLayer(layer)
}
