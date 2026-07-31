import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import bboxClip from '@turf/bbox-clip'
import {
  simplifyPolygonTopology,
  TOPOLOGY_PROFILES,
} from '../../lib/mapshaper-topology.mjs'

const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'output', 'BCRange')
const WFS_BASE = 'https://openmaps.gov.bc.ca/geo/pub'
const PG_REGION_BBOX = [-125, 52.5, -120, 55.5]
const SOURCE_CRS = 'EPSG:4326'
const WORKING_CRS = 'EPSG:3005'
const OUTPUT_CRS = 'EPSG:4326'
const COORDINATE_PRECISION = 6

const LAYERS = [
  {
    id: 'range_tenures',
    typeName: 'WHSE_FOREST_TENURE.FTEN_RANGE_POLY_SVW',
    sourceLayer: 'WHSE_FOREST_TENURE.FTEN_RANGE_POLY_SVW',
    geomField: 'GEOMETRY',
    cqlFilter: "LIFE_CYCLE_STATUS_CODE='ACTIVE'",
    codeField: 'FOREST_FILE_ID',
    keepFields: [
      'OBJECTID',
      'FOREST_FILE_ID',
      'MAP_BLOCK_ID',
      'MAP_LABEL',
      'CLIENT_NUMBER',
      'CLIENT_NAME',
      'FILE_TYPE_CODE',
      'AUTHORIZED_USE',
      'TOTAL_ANNUAL_USE',
      'AREA_HA',
      'FILE_STATUS_CODE',
      'LIFE_CYCLE_STATUS_CODE',
      'ADMIN_DISTRICT_CODE',
      'ADMIN_DISTRICT_NAME',
    ],
    toleranceMetres: 100,
    nameBuilder: (props) => {
      const file = String(props.FOREST_FILE_ID ?? '').trim()
      const block = String(props.MAP_BLOCK_ID ?? '').trim()
      const client = String(props.CLIENT_NAME ?? '').trim()
      const parts = []
      if (file) parts.push(block ? `${file}-${block}` : file)
      if (client) parts.push(client)
      return parts.join(' · ')
    },
  },
  {
    id: 'range_pastures',
    typeName: 'WHSE_FOREST_VEGETATION.RANGE_PASTURE_POLY_SVW',
    sourceLayer: 'WHSE_FOREST_VEGETATION.RANGE_PASTURE_POLY_SVW',
    geomField: 'GEOMETRY',
    cqlFilter: null,
    codeField: 'OBJECTID',
    keepFields: [
      'OBJECTID',
      'RANGE_UNIT_ID',
      'RANGE_PASTURE_ID',
      'PASTURE_NAME',
      'DISTRICT_RESPONSIBLE_CODE',
      'OWNERSHIP_CODE',
      'FEATURE_AREA_SQM',
    ],
    toleranceMetres: 100,
    nameBuilder: (props) => String(props.PASTURE_NAME ?? '').trim(),
  },
]

function getWfsUrl(layer) {
  // BCGW WFS rejects bbox + CQL_FILTER together, so fold the bbox into the
  // filter using the 6-arg BBOX form (default CRS is the layer's native BC
  // Albers, so the EPSG:4326 hint is required).
  const bboxClause = `BBOX(${layer.geomField},${PG_REGION_BBOX.join(',')},'EPSG:4326')`
  const cqlFilter = layer.cqlFilter ? `(${layer.cqlFilter}) AND ${bboxClause}` : bboxClause

  const params = new URLSearchParams({
    service: 'WFS',
    version: '1.0.0',
    request: 'GetFeature',
    typeName: `pub:${layer.typeName}`,
    outputFormat: 'json',
    srsName: 'EPSG:4326',
    maxFeatures: '20000',
    CQL_FILTER: cqlFilter,
  })

  return `${WFS_BASE}/${layer.typeName}/ows?${params.toString()}`
}

function pickProperties(properties, layer) {
  const code = String(properties[layer.codeField] ?? properties.OBJECTID ?? '').trim()
  const builtName = layer.nameBuilder(properties)

  const next = {
    sourceLayer: layer.sourceLayer,
    boundaryCode: code,
    boundaryName: builtName || code,
  }

  for (const field of layer.keepFields) {
    if (properties[field] !== undefined && properties[field] !== null) {
      next[field] = properties[field]
    }
  }

  return next
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

  if (!clipped.geometry) return null

  return {
    type: 'Feature',
    id: feature.id,
    properties: pickProperties(feature.properties ?? {}, layer),
    geometry: clipped.geometry,
  }
}

async function syncLayer(layer) {
  const response = await fetch(getWfsUrl(layer))
  if (!response.ok) {
    throw new Error(`Failed to fetch ${layer.typeName}: ${response.status}`)
  }

  const source = await response.json()
  const features = source.features
    .map((feature) => normalizeFeature(feature, layer))
    .filter((feature) => feature && feature.properties.boundaryCode)

  const simplified = simplifyPolygonTopology({
    type: 'FeatureCollection',
    name: layer.id,
    features,
  }, {
    toleranceMetres: layer.toleranceMetres,
    sourceCrs: SOURCE_CRS,
    workingCrs: WORKING_CRS,
    outputCrs: OUTPUT_CRS,
    coordinatePrecision: COORDINATE_PRECISION,
    topologyProfile: TOPOLOGY_PROFILES.OVERLAP,
    tempPrefix: `bc-${layer.id}-`,
  })

  const collection = {
    type: 'FeatureCollection',
    name: layer.id,
    metadata: {
      source: 'BC Geographic Warehouse',
      sourceLayer: layer.sourceLayer,
      bbox: PG_REGION_BBOX,
      clippedTo: 'Prince George regional viewport',
      cqlFilter: layer.cqlFilter ?? null,
      ...simplified.metadata,
    },
    features: simplified.features,
  }

  await writeFile(`${OUTPUT_DIR}/${layer.id}.geojson`, `${JSON.stringify(collection)}\n`)
  console.log(`${layer.id}: wrote ${simplified.features.length} features`)
}

await mkdir(OUTPUT_DIR, { recursive: true })
for (const layer of LAYERS) {
  await syncLayer(layer)
}
