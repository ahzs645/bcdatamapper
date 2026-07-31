import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import bboxClip from '@turf/bbox-clip'
import {
  simplifyPolygonTopology,
  TOPOLOGY_PROFILES,
} from '../../lib/mapshaper-topology.mjs'

const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'output', 'BCUWR')
const WFS_BASE = 'https://openmaps.gov.bc.ca/geo/pub'
const SOURCE_CRS = 'EPSG:4326'
const WORKING_CRS = 'EPSG:3005'
const OUTPUT_CRS = 'EPSG:4326'
const COORDINATE_PRECISION = 6

/**
 * Province-wide extract: every UWR polygon in the BCGW, not a regional subset.
 * Set this to `[west, south, east, north]` to go back to a clipped window —
 * the WFS query, the per-feature clip and the emitted metadata all follow it.
 */
const REGION_BBOX = null

/** The WFS caps a single GetFeature response, so results are paged. */
const PAGE_SIZE = 10000

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
  toleranceMetres: 100,
}

function getWfsUrl(typeName, startIndex) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: `pub:${typeName}`,
    outputFormat: 'json',
    srsName: 'EPSG:4326',
    count: String(PAGE_SIZE),
    startIndex: String(startIndex),
  })
  if (REGION_BBOX) params.set('bbox', `${REGION_BBOX.join(',')},EPSG:4326`)

  return `${WFS_BASE}/${typeName}/ows?${params.toString()}`
}

/** One page, with a short backoff so a single blip does not lose the whole run. */
async function fetchPage(typeName, startIndex) {
  let lastError
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(getWfsUrl(typeName, startIndex))
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 3000 * attempt))
    }
  }
  throw new Error(`Failed to fetch ${typeName} at startIndex ${startIndex}: ${lastError.message}`)
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

  let clipped = feature
  if (REGION_BBOX) {
    try {
      clipped = bboxClip(feature, REGION_BBOX)
    } catch {
      return null
    }
  }

  if (!clipped.geometry) return null

  // bboxClip can return empty Polygon/MultiPolygon coordinate arrays for
  // features that the WFS bbox query includes but that do not actually
  // intersect the viewport. Those shapes are invalid GeoJSON and crash
  // MapLibre's worker while it indexes the source.
  if (!isUsablePolygonGeometry(clipped.geometry)) return null

  return {
    type: 'Feature',
    id: feature.id,
    properties: pickProperties(feature.properties ?? {}, layer.keepFields, layer.sourceLayer),
    geometry: clipped.geometry,
  }
}

async function syncLayer(layer) {
  const features = []
  let received = 0

  for (;;) {
    const page = await fetchPage(layer.typeName, received)
    const pageFeatures = page.features ?? []
    if (pageFeatures.length === 0) break

    for (const feature of pageFeatures) {
      const normalized = normalizeFeature(feature, layer)
      if (normalized && normalized.properties.boundaryCode) features.push(normalized)
    }

    received += pageFeatures.length
    console.log(`  ${layer.id}: ${received} fetched, ${features.length} kept`)
    if (pageFeatures.length < PAGE_SIZE) break
  }

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
    tempPrefix: 'bc-uwr-',
  })

  const collection = {
    type: 'FeatureCollection',
    name: layer.id,
    metadata: {
      source: 'BC Geographic Warehouse',
      sourceLayer: layer.sourceLayer,
      // `bbox`/`clippedTo` stay null for a province-wide extract so the app can
      // tell "the whole layer" apart from "a window into it" and caveat honestly.
      bbox: REGION_BBOX,
      clippedTo: REGION_BBOX ? 'Prince George regional viewport' : null,
      extent: REGION_BBOX ? 'regional subset' : 'Full British Columbia',
      featureCount: simplified.features.length,
      ...simplified.metadata,
    },
    features: simplified.features,
  }

  // Shipped gzipped: `useFetchData` sniffs the gzip magic bytes and inflates
  // via DecompressionStream, so the app reads the `.gz` path directly.
  const raw = Buffer.from(`${JSON.stringify(collection)}\n`, 'utf8')
  const gz = gzipSync(raw, { level: 9 })
  await writeFile(`${OUTPUT_DIR}/${layer.id}.geojson.gz`, gz)
  // Drop the uncompressed sibling a previous run may have left behind, so the
  // synced-to-public copy does not keep serving a stale plain file.
  await rm(`${OUTPUT_DIR}/${layer.id}.geojson`, { force: true })

  const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`
  console.log(
    `${layer.id}: wrote ${simplified.features.length} features (${mb(raw.byteLength)} raw -> ${mb(gz.byteLength)} gzip)`,
  )
}

await mkdir(OUTPUT_DIR, { recursive: true })
await syncLayer(LAYER)
