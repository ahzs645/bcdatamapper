import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAPSHAPER_VERSION,
  simplifySharedPolygonTopology,
} from '../../lib/mapshaper-topology.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const SIMPLIFIED_OUTPUT_DIR = path.join(SCRIPT_DIR, 'output', 'BCFWA')
const FULL_OUTPUT_DIR = process.env.FWA_FULL_OUTPUT_DIR
  ?? '/Users/ahmadjalil/Library/CloudStorage/GoogleDrive-ahzs645@gmail.com/My Drive/University/Research/Grad/Data/Boundaries'
const WFS_BASE = 'https://openmaps.gov.bc.ca/geo/pub'
const SOURCE_CRS = 'EPSG:4326'
const WORKING_CRS = 'EPSG:3005'
const OUTPUT_CRS = 'EPSG:4326'
const COORDINATE_PRECISION = 6

const LAYERS = [
  {
    id: 'major_watersheds',
    typeName: 'WHSE_BASEMAPPING.BC_MAJOR_WATERSHEDS',
    codeField: 'OBJECTID',
    nameField: 'MAJOR_WATERSHED_SYSTEM',
    keepFields: ['OBJECTID', 'MAJOR_WATERSHED_CODE', 'MAJOR_WATERSHED_SYSTEM', 'FEATURE_AREA_SQM'],
    toleranceMetres: 100,
  },
  {
    id: 'watershed_groups',
    typeName: 'WHSE_BASEMAPPING.FWA_WATERSHED_GROUPS_POLY',
    codeField: 'WATERSHED_GROUP_CODE',
    nameField: 'WATERSHED_GROUP_NAME',
    keepFields: ['OBJECTID', 'WATERSHED_GROUP_ID', 'WATERSHED_GROUP_CODE', 'WATERSHED_GROUP_NAME', 'AREA_HA'],
    toleranceMetres: 75,
  },
]

function getWfsUrl(typeName) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: `pub:${typeName}`,
    outputFormat: 'json',
    srsName: 'EPSG:4326',
    count: '1000',
  })

  return `${WFS_BASE}/${typeName}/ows?${params.toString()}`
}

function pickProperties(properties, layer) {
  const next = {
    sourceLayer: layer.typeName,
    boundaryCode: String(properties[layer.codeField] ?? properties.OBJECTID ?? '').trim(),
    boundaryName: String(properties[layer.nameField] ?? properties.OBJECTID ?? '').trim(),
  }

  for (const field of layer.keepFields) {
    if (properties[field] !== undefined && properties[field] !== null) {
      next[field] = properties[field]
    }
  }

  return next
}

async function fetchFullLayer(layer) {
  const response = await fetch(getWfsUrl(layer.typeName))
  if (!response.ok) {
    throw new Error(`Failed to fetch ${layer.typeName}: ${response.status}`)
  }

  const payload = Buffer.from(await response.arrayBuffer())
  const fullPath = `${FULL_OUTPUT_DIR}/${layer.id}_province_full.geojson`
  await writeFile(fullPath, payload)
  console.log(`${layer.id}: wrote full WFS source to ${fullPath} (${payload.byteLength.toLocaleString()} bytes)`)
  return fullPath
}

async function simplifyLayer(layer, fullPath) {
  const outputPath = `${SIMPLIFIED_OUTPUT_DIR}/${layer.id}_province_simplified.geojson`
  const full = JSON.parse(await readFile(fullPath, 'utf8'))
  const normalized = {
    type: 'FeatureCollection',
    features: full.features
    .filter((feature) => feature.geometry && (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon'))
    .map((feature) => ({
      type: 'Feature',
      id: feature.id,
      properties: pickProperties(feature.properties ?? {}, layer),
      geometry: feature.geometry,
    }))
    .filter((feature) => feature.properties.boundaryCode),
  }
  const simplified = simplifySharedPolygonTopology(normalized, {
    toleranceMetres: layer.toleranceMetres,
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
      source: 'BC Freshwater Atlas / BC Geographic Warehouse',
      sourceLayer: layer.typeName,
      scope: 'Province-wide',
      sourceCrs: SOURCE_CRS,
      workingCrs: WORKING_CRS,
      outputCrs: OUTPUT_CRS,
      simplification: 'Mapshaper shared-topology Ramer-Douglas-Peucker',
      simplificationToleranceMetres: layer.toleranceMetres,
      topologyPreserving: true,
      mapshaperVersion: MAPSHAPER_VERSION,
      coordinatePrecision: COORDINATE_PRECISION,
      numberMatched: features.length,
      fullSourcePath: fullPath,
    },
    features,
  }

  const payload = `${JSON.stringify(collection)}\n`
  await writeFile(outputPath, payload)
  console.log(`${layer.id}: wrote topology-preserving simplified file (${Buffer.byteLength(payload).toLocaleString()} bytes)`)
}

await mkdir(SIMPLIFIED_OUTPUT_DIR, { recursive: true })
await mkdir(FULL_OUTPUT_DIR, { recursive: true })

for (const layer of LAYERS) {
  const fullPath = await fetchFullLayer(layer)
  await simplifyLayer(layer, fullPath)
}
