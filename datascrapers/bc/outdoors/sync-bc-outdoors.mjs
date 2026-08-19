#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import area from '@turf/area'
import {
  MAPSHAPER_VERSION,
  simplifyPolygonTopology,
  TOPOLOGY_PROFILES,
} from '../../lib/mapshaper-topology.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = join(SCRIPT_DIR, 'output')
const SOURCE_REGISTRY_PATH = join(SCRIPT_DIR, 'sources.json')
const COORDINATE_PRECISION = 6

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' })
}

function countPositions(geometry) {
  if (geometry?.type === 'Polygon') {
    return geometry.coordinates.reduce((total, ring) => total + ring.length, 0)
  }
  if (geometry?.type === 'MultiPolygon') {
    return geometry.coordinates.reduce(
      (total, polygon) => total + polygon.reduce((subtotal, ring) => subtotal + ring.length, 0),
      0,
    )
  }
  return 0
}

function normalizeWmuFeature(feature, layer) {
  if (!feature.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) return null
  const properties = feature.properties ?? {}
  const id = String(properties.WILDLIFE_MGMT_UNIT_ID ?? '').trim()
  if (!id) return null

  return {
    type: 'Feature',
    id,
    geometry: feature.geometry,
    properties: {
      planningClass: 'management-context',
      authority: 'official',
      boundaryCode: id,
      boundaryName: `Management Unit ${id}`,
      managementUnitId: id,
      regionId: properties.REGION_RESPONSIBLE ?? null,
      regionName: properties.REGION_RESPONSIBLE_NAME ?? null,
      gameManagementZoneId: properties.GAME_MANAGEMENT_ZONE_ID ?? null,
      gameManagementZoneName: properties.GAME_MANAGEMENT_ZONE_NAME ?? null,
      sourceObjectId: properties.OBJECTID ?? feature.id ?? null,
      sourceAreaSqM: properties.FEATURE_AREA_SQM ?? null,
      sourceLengthM: properties.FEATURE_LENGTH_M ?? null,
      sourceLayer: layer.sourceLayer,
    },
  }
}

async function fetchLayerMetadata(layer) {
  const [serviceResponse, catalogueResponse] = await Promise.all([
    fetch(`${layer.serviceUrl}?f=json`),
    fetch(layer.metadataApiUrl),
  ])
  if (!serviceResponse.ok) throw new Error(`Failed to fetch WMU service metadata: HTTP ${serviceResponse.status}`)
  if (!catalogueResponse.ok) throw new Error(`Failed to fetch WMU catalogue metadata: HTTP ${catalogueResponse.status}`)
  const [service, catalogue] = await Promise.all([serviceResponse.json(), catalogueResponse.json()])
  if (service.error) throw new Error(`WMU service metadata error: ${JSON.stringify(service.error)}`)
  if (!catalogue.success) throw new Error(`WMU catalogue metadata error: ${JSON.stringify(catalogue.error ?? catalogue)}`)
  return { service, catalogue: catalogue.result }
}

async function fetchWildlifeManagementUnits(layer) {
  const url = new URL(`${layer.serviceUrl}/query`)
  url.searchParams.set('where', '1=1')
  url.searchParams.set('outFields', [
    'OBJECTID',
    'WILDLIFE_MGMT_UNIT_ID',
    'REGION_RESPONSIBLE',
    'REGION_RESPONSIBLE_NAME',
    'GAME_MANAGEMENT_ZONE_ID',
    'GAME_MANAGEMENT_ZONE_NAME',
    'FEATURE_AREA_SQM',
    'FEATURE_LENGTH_M',
  ].join(','))
  url.searchParams.set('returnGeometry', 'true')
  url.searchParams.set('outSR', '3005')
  url.searchParams.set('f', 'geojson')

  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to fetch Wildlife Management Units: HTTP ${response.status}`)
  const collection = await response.json()
  if (collection.error) throw new Error(`WMU query error: ${JSON.stringify(collection.error)}`)
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('WMU service did not return a GeoJSON FeatureCollection')
  }

  const features = collection.features
    .map((feature) => normalizeWmuFeature(feature, layer))
    .filter(Boolean)
    .sort((left, right) => naturalCompare(left.id, right.id))

  if (features.length !== layer.expectedFeatureCount) {
    throw new Error(`Expected ${layer.expectedFeatureCount} WMUs, received ${features.length}`)
  }
  const ids = new Set(features.map((feature) => feature.id))
  if (ids.size !== features.length) throw new Error('WMU identifiers are not unique')
  for (const requiredId of layer.requiredIds ?? []) {
    if (!ids.has(requiredId)) throw new Error(`Required WMU ${requiredId} is missing`)
  }

  return { type: 'FeatureCollection', name: layer.id, features }
}

function isoDate(value) {
  if (!Number.isFinite(value)) return null
  return new Date(value).toISOString()
}

function validateAreaDrift(features) {
  let maxAreaDriftPercent = 0
  let maxAreaDriftFeatureId = null
  for (const feature of features) {
    const sourceAreaSqM = Number(feature.properties?.sourceAreaSqM)
    if (!Number.isFinite(sourceAreaSqM) || sourceAreaSqM <= 0) continue
    const outputAreaSqM = area(feature)
    const driftPercent = Math.abs(outputAreaSqM - sourceAreaSqM) / sourceAreaSqM * 100
    feature.properties.outputAreaSqM = Math.round(outputAreaSqM)
    feature.properties.areaDriftPercent = Number(driftPercent.toFixed(6))
    if (driftPercent > maxAreaDriftPercent) {
      maxAreaDriftPercent = driftPercent
      maxAreaDriftFeatureId = feature.id
    }
  }
  return {
    maxAreaDriftPercent: Number(maxAreaDriftPercent.toFixed(6)),
    maxAreaDriftFeatureId,
  }
}

async function syncWildlifeManagementUnits(registry, layer) {
  console.log(`Fetching ${layer.title}...`)
  const [source, serviceMetadata] = await Promise.all([
    fetchWildlifeManagementUnits(layer),
    fetchLayerMetadata(layer),
  ])
  const rawVertices = source.features.reduce((total, feature) => total + countPositions(feature.geometry), 0)
  const simplified = simplifyPolygonTopology(source, {
    toleranceMetres: layer.simplificationToleranceMetres,
    sourceCrs: layer.sourceCrs,
    workingCrs: layer.workingCrs,
    outputCrs: layer.outputCrs,
    coordinatePrecision: COORDINATE_PRECISION,
    topologyProfile: TOPOLOGY_PROFILES.PARTITION,
    tempPrefix: 'bc-outdoors-wmu-',
  })
  simplified.features.sort((left, right) => naturalCompare(left.id, right.id))
  const outputVertices = simplified.features.reduce((total, feature) => total + countPositions(feature.geometry), 0)
  const areaValidation = validateAreaDrift(simplified.features)
  if (areaValidation.maxAreaDriftPercent > 1) {
    throw new Error(
      `WMU ${areaValidation.maxAreaDriftFeatureId} changed area by ${areaValidation.maxAreaDriftPercent}%`,
    )
  }

  const sourceLastModifiedAt = isoDate(serviceMetadata.service.editingInfo?.lastEditDate)
    ?? serviceMetadata.catalogue.metadata_modified
    ?? null
  const collection = {
    type: 'FeatureCollection',
    name: layer.id,
    metadata: {
      sourceOrganization: layer.sourceOrganization,
      sourceLayer: layer.sourceLayer,
      metadataUrl: layer.metadataUrl,
      metadataApiUrl: layer.metadataApiUrl,
      serviceUrl: layer.serviceUrl,
      licence: registry.licence,
      extent: 'Full British Columbia',
      sourceLastModifiedAt,
      sourceCrs: layer.sourceCrs,
      workingCrs: layer.workingCrs,
      outputCrs: layer.outputCrs,
      simplification: 'Mapshaper shared-topology Ramer-Douglas-Peucker',
      simplificationToleranceMetres: layer.simplificationToleranceMetres,
      topologyPreserving: true,
      mapshaperVersion: MAPSHAPER_VERSION,
      coordinatePrecision: COORDINATE_PRECISION,
      sourceFeatureCount: source.features.length,
      outputFeatureCount: simplified.features.length,
      rawVertices,
      outputVertices,
      ...areaValidation,
      ...simplified.metadata,
    },
    features: simplified.features,
  }

  const raw = Buffer.from(`${JSON.stringify(collection)}\n`, 'utf8')
  const compressed = gzipSync(raw, { level: 9 })
  const relativePath = join('regulatory', 'wildlife-management-units.geojson.gz')
  const outputPath = join(OUTPUT_DIR, relativePath)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, compressed)
  await rm(outputPath.replace(/\.gz$/, ''), { force: true })

  return {
    id: layer.id,
    title: layer.title,
    archive: layer.archive,
    path: relativePath,
    featureCount: collection.features.length,
    bytes: compressed.byteLength,
    rawBytes: raw.byteLength,
    sourceLastModifiedAt,
    metadata: collection.metadata,
  }
}

const registry = JSON.parse(await readFile(SOURCE_REGISTRY_PATH, 'utf8'))
await mkdir(OUTPUT_DIR, { recursive: true })

const layers = []
for (const layer of registry.layers) {
  if (layer.id === 'wildlife_management_units') {
    layers.push(await syncWildlifeManagementUnits(registry, layer))
  } else {
    throw new Error(`No sync implementation for outdoors layer ${layer.id}`)
  }
}

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  generatedBy: 'datascrapers/bc/outdoors/sync-bc-outdoors.mjs',
  complete: true,
  licence: registry.licence,
  layers,
  plannedLayers: registry.plannedLayers,
}
await writeFile(join(OUTPUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(JSON.stringify({
  output: OUTPUT_DIR,
  layers: layers.map(({ id, featureCount, bytes, rawBytes }) => ({ id, featureCount, bytes, rawBytes })),
}, null, 2))
