import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAPSHAPER_VERSION,
  simplifySharedPolygonTopology,
} from '../../lib/mapshaper-topology.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output', 'BCNR')
const WFS_BASE = 'https://openmaps.gov.bc.ca/geo/pub'
const SOURCE_CRS = 'EPSG:4326'
const WORKING_CRS = 'EPSG:3005'
const OUTPUT_CRS = 'EPSG:4326'
const COORDINATE_PRECISION = 6

const LAYERS = [
  {
    id: 'nr_areas',
    typeName: 'WHSE_ADMIN_BOUNDARIES.ADM_NR_AREAS_SPG',
    sourceLayer: 'WHSE_ADMIN_BOUNDARIES.ADM_NR_AREAS_SPG',
    codeField: 'AREA_NUMBER',
    nameField: 'AREA_NAME',
    keepFields: ['OBJECTID', 'AREA_NUMBER', 'AREA_NAME', 'FEATURE_AREA_SQM'],
    toleranceMetres: 250,
  },
  {
    id: 'nr_regions',
    typeName: 'WHSE_ADMIN_BOUNDARIES.ADM_NR_REGIONS_SPG',
    sourceLayer: 'WHSE_ADMIN_BOUNDARIES.ADM_NR_REGIONS_SPG',
    codeField: 'ORG_UNIT',
    nameField: 'REGION_NAME',
    keepFields: ['OBJECTID', 'ORG_UNIT', 'ORG_UNIT_NAME', 'REGION_NAME', 'FEATURE_AREA_SQM'],
    toleranceMetres: 150,
  },
  {
    id: 'nr_districts',
    typeName: 'WHSE_ADMIN_BOUNDARIES.ADM_NR_DISTRICTS_SPG',
    sourceLayer: 'WHSE_ADMIN_BOUNDARIES.ADM_NR_DISTRICTS_SPG',
    codeField: 'ORG_UNIT',
    nameField: 'DISTRICT_NAME',
    keepFields: [
      'OBJECTID',
      'ORG_UNIT',
      'ORG_UNIT_NAME',
      'DISTRICT_NAME',
      'REGION_ORG_UNIT',
      'REGION_ORG_UNIT_NAME',
      'FEATURE_AREA_SQM',
    ],
    toleranceMetres: 100,
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
  })

  return `${WFS_BASE}/${typeName}/ows?${params.toString()}`
}

function pickProperties(properties, keepFields, codeField, nameField, sourceLayer) {
  const next = {
    sourceLayer,
    boundaryCode: String(properties[codeField] ?? properties.OBJECTID ?? '').trim(),
    boundaryName: String(properties[nameField] ?? '').trim(),
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

function normalizeFeature(feature, layer) {
  if (!feature.geometry || (feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon')) {
    return null
  }

  return {
    type: 'Feature',
    id: feature.id,
    properties: pickProperties(feature.properties ?? {}, layer.keepFields, layer.codeField, layer.nameField, layer.sourceLayer),
    geometry: feature.geometry,
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
  const simplified = simplifySharedPolygonTopology({
    type: 'FeatureCollection',
    features: normalizedFeatures,
  }, {
    toleranceMetres: layer.toleranceMetres,
    sourceCrs: SOURCE_CRS,
    workingCrs: WORKING_CRS,
    outputCrs: OUTPUT_CRS,
    coordinatePrecision: COORDINATE_PRECISION,
    tempPrefix: `bc-${layer.id}-`,
  })
  const features = simplified.features

  const collection = {
    type: 'FeatureCollection',
    name: layer.id,
    metadata: {
      source: 'BC Geographic Warehouse',
      sourceLayer: layer.sourceLayer,
      coverage: 'BC-wide (administrative boundaries)',
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

  await writeFile(path.join(OUTPUT_DIR, `${layer.id}.geojson`), `${JSON.stringify(collection)}\n`)
  console.log(`${layer.id}: wrote ${features.length} features`)
}

await mkdir(OUTPUT_DIR, { recursive: true })
for (const layer of LAYERS) {
  await syncLayer(layer)
}
