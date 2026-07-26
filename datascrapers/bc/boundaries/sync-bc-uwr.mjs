import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import bboxClip from '@turf/bbox-clip'
import simplify from '@turf/simplify'

const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'output', 'BCUWR')
const WFS_BASE = 'https://openmaps.gov.bc.ca/geo/pub'
const PG_REGION_BBOX = [-125, 52.5, -120, 55.5]

const LAYER = {
  id: 'ungulate_winter_range',
  typeName: 'WHSE_WILDLIFE_MANAGEMENT.WCP_UNGULATE_WINTER_RANGE_SP',
  sourceLayer: 'WHSE_WILDLIFE_MANAGEMENT.WCP_UNGULATE_WINTER_RANGE_SP',
  keepFields: [
    'OBJECTID',
    'UNGULATE_WINTER_RANGE_ID',
    'UWR_NUMBER',
    'UWR_UNIT_NUMBER',
    'SPECIES_1',
    'SPECIES_2',
    'APPROVAL_DATE',
    'TIMBER_HARVEST_CODE',
    'LEGISLATION_ACT_NAME',
    'HECTARES',
  ],
  tolerance: 0.001,
}

function getWfsUrl(typeName) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '1.0.0',
    request: 'GetFeature',
    typeName: `pub:${typeName}`,
    outputFormat: 'json',
    srsName: 'EPSG:4326',
    bbox: `${PG_REGION_BBOX.join(',')},EPSG:4326`,
    maxFeatures: '20000',
  })

  return `${WFS_BASE}/${typeName}/ows?${params.toString()}`
}

function pickProperties(properties, keepFields, sourceLayer) {
  const uwrNumber = String(properties.UWR_NUMBER ?? '').trim()
  const unitNumber = String(properties.UWR_UNIT_NUMBER ?? '').trim()
  const code =
    uwrNumber && unitNumber
      ? `${uwrNumber}-${unitNumber}`
      : String(properties.UNGULATE_WINTER_RANGE_ID ?? properties.OBJECTID ?? '').trim()

  const species = String(properties.SPECIES_1 ?? '').trim()
  const labelParts = [uwrNumber || code]
  if (unitNumber) labelParts.push(`unit ${unitNumber}`)
  if (species) labelParts.push(species)

  const next = {
    sourceLayer,
    boundaryCode: code,
    boundaryName: labelParts.filter(Boolean).join(' · ') || code,
  }

  for (const field of keepFields) {
    if (properties[field] !== undefined && properties[field] !== null) {
      next[field] = properties[field]
    }
  }

  return next
}

function isFinitePosition(position) {
  return Array.isArray(position) && position.length >= 2 && Number.isFinite(position[0]) && Number.isFinite(position[1])
}

function isUsableRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4 || !ring.every(isFinitePosition)) return false

  const first = ring[0]
  const last = ring[ring.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) return false

  return new Set(ring.slice(0, -1).map(([lon, lat]) => `${lon},${lat}`)).size >= 3
}

function isUsablePolygonCoordinates(coordinates) {
  return Array.isArray(coordinates) && coordinates.length > 0 && coordinates.every(isUsableRing)
}

function isUsablePolygonGeometry(geometry) {
  if (geometry?.type === 'Polygon') {
    return isUsablePolygonCoordinates(geometry.coordinates)
  }
  if (geometry?.type === 'MultiPolygon') {
    return (
      Array.isArray(geometry.coordinates) &&
      geometry.coordinates.length > 0 &&
      geometry.coordinates.every(isUsablePolygonCoordinates)
    )
  }
  return false
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

  const simplified = simplify(clipped, {
    tolerance: layer.tolerance,
    highQuality: false,
    mutate: true,
  })

  // bboxClip can return empty Polygon/MultiPolygon coordinate arrays for
  // features that the WFS bbox query includes but that do not actually
  // intersect the viewport. Those shapes are invalid GeoJSON and crash
  // MapLibre's worker while it indexes the source.
  if (!isUsablePolygonGeometry(simplified.geometry)) return null

  return {
    type: 'Feature',
    id: feature.id,
    properties: pickProperties(feature.properties ?? {}, layer.keepFields, layer.sourceLayer),
    geometry: simplified.geometry,
  }
}

async function syncLayer(layer) {
  const response = await fetch(getWfsUrl(layer.typeName))
  if (!response.ok) {
    throw new Error(`Failed to fetch ${layer.typeName}: ${response.status}`)
  }

  const source = await response.json()
  const features = source.features
    .map((feature) => normalizeFeature(feature, layer))
    .filter((feature) => feature && feature.properties.boundaryCode)

  const collection = {
    type: 'FeatureCollection',
    name: layer.id,
    metadata: {
      source: 'BC Geographic Warehouse',
      sourceLayer: layer.sourceLayer,
      bbox: PG_REGION_BBOX,
      clippedTo: 'Prince George regional viewport',
      generatedAt: new Date().toISOString(),
    },
    features,
  }

  await writeFile(`${OUTPUT_DIR}/${layer.id}.geojson`, `${JSON.stringify(collection)}\n`)
  console.log(`${layer.id}: wrote ${features.length} features`)
}

await mkdir(OUTPUT_DIR, { recursive: true })
await syncLayer(LAYER)
