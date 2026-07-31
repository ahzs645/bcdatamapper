#!/usr/bin/env node
/* global Buffer, URLSearchParams, console, fetch, process */

import fs from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import * as turf from '@turf/turf'
import {
  MAPSHAPER_VERSION,
  simplifyPolygonTopology,
  TOPOLOGY_PROFILES,
} from '../lib/mapshaper-topology.mjs'

const SERVICE_BASE = 'https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer'
const DA_LAYER_ID = 12
const PARENT_LAYER_DEFS = [
  {
    level: 'cd',
    label: 'Census Division',
    layerId: 4,
    idKey: 'CDUID',
    nameKey: 'CDNAME',
    typeKey: 'CDTYPE',
    toleranceMetres: 50,
  },
  {
    level: 'csd',
    label: 'Census Subdivision',
    layerId: 9,
    idKey: 'CSDUID',
    nameKey: 'CSDNAME',
    typeKey: 'CSDTYPE',
    toleranceMetres: 50,
  },
  {
    level: 'ct',
    label: 'Census Tract',
    layerId: 11,
    idKey: 'CTUID',
    nameKey: 'CTNAME',
    typeKey: null,
    toleranceMetres: 20,
  },
]
const BC_PRUID = '59'
const FETCH_PAGE_SIZE = 500
const PARENT_FETCH_PAGE_SIZE = 25
const SOURCE_CRS = 'EPSG:4326'
const WORKING_CRS = 'EPSG:3005'
const OUTPUT_CRS = 'EPSG:4326'
const COORDINATE_PRECISION = 6

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const censusDir = __dirname
const tmpDir = path.join(censusDir, 'tmp')
const defaultSourcePath = path.join(tmpDir, 'bc-da-source.geojson')
const defaultParentsPath = path.join(tmpDir, 'bc-census-parent-boundaries.geojson')
const outputDir = path.join(censusDir, 'output', 'bc-da-simplified')

const DEFAULT_LODS = [
  {
    id: 'overview',
    label: 'Overview',
    tolerance: 0.001,
    toleranceMetres: 100,
    minZoom: 0,
    maxZoom: 8.5,
  },
  {
    id: 'medium',
    label: 'Medium',
    tolerance: 0.0002,
    toleranceMetres: 20,
    minZoom: 8.5,
    maxZoom: 24,
  },
]

function parseArgs(argv) {
  const options = {
    source: '',
    tolerance: 0.0002,
    lods: DEFAULT_LODS,
    gridCols: 6,
    gridRows: 5,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const [key, inlineValue] = arg.split('=')
    const nextValue = inlineValue ?? argv[index + 1]

    if (key === '--source') {
      options.source = nextValue
      if (inlineValue == null) index += 1
    } else if (key === '--tolerance') {
      options.tolerance = Number(nextValue)
      options.lods = [{
        id: 'medium',
        label: 'Medium',
        tolerance: options.tolerance,
        toleranceMetres: options.tolerance * 100_000,
        minZoom: 0,
        maxZoom: 24,
      }]
      if (inlineValue == null) index += 1
    } else if (key === '--tolerance-metres') {
      options.lods = [{
        id: 'medium',
        label: 'Medium',
        tolerance: Number(nextValue) / 100_000,
        toleranceMetres: Number(nextValue),
        minZoom: 0,
        maxZoom: 24,
      }]
      if (inlineValue == null) index += 1
    } else if (key === '--lods') {
      options.lods = parseLods(nextValue)
      if (inlineValue == null) index += 1
    } else if (key === '--grid-cols') {
      options.gridCols = Number.parseInt(nextValue, 10)
      if (inlineValue == null) index += 1
    } else if (key === '--grid-rows') {
      options.gridRows = Number.parseInt(nextValue, 10)
      if (inlineValue == null) index += 1
    }
  }

  if (options.lods.some((lod) => !Number.isFinite(lod.toleranceMetres) || lod.toleranceMetres <= 0)) {
    throw new Error('Every LOD tolerance must be a positive number')
  }
  if (!Number.isInteger(options.gridCols) || options.gridCols < 1) {
    throw new Error('--grid-cols must be a positive integer')
  }
  if (!Number.isInteger(options.gridRows) || options.gridRows < 1) {
    throw new Error('--grid-rows must be a positive integer')
  }

  return options
}

function parseLods(value) {
  if (!value) return DEFAULT_LODS

  const lods = String(value).split(',').map((entry) => {
    const [id, toleranceRaw, minZoomRaw = '0', maxZoomRaw = '24'] = entry.split(':')
    const normalizedId = String(id ?? '').trim()
    const tolerance = Number(toleranceRaw)
    const minZoom = Number(minZoomRaw)
    const maxZoom = Number(maxZoomRaw)
    if (!normalizedId) {
      throw new Error(`Invalid LOD entry "${entry}": missing id`)
    }
    if (!Number.isFinite(tolerance) || tolerance <= 0) {
      throw new Error(`Invalid LOD entry "${entry}": bad tolerance`)
    }
    if (!Number.isFinite(minZoom) || !Number.isFinite(maxZoom) || maxZoom <= minZoom) {
      throw new Error(`Invalid LOD entry "${entry}": bad zoom range`)
    }

    return {
      id: normalizedId,
      label: normalizedId.charAt(0).toUpperCase() + normalizedId.slice(1),
      tolerance,
      toleranceMetres: tolerance * 100_000,
      minZoom,
      maxZoom,
    }
  })

  return lods.sort((a, b) => a.minZoom - b.minZoom)
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Request failed (${response.status}) for ${url}\n${body.slice(0, 500)}`)
  }
  return response.json()
}

async function fetchBcDaSource() {
  const idParams = new URLSearchParams({
    where: `PRUID='${BC_PRUID}'`,
    returnIdsOnly: 'true',
    f: 'json',
  })
  const idJson = await fetchJson(`${SERVICE_BASE}/${DA_LAYER_ID}/query?${idParams.toString()}`)
  const objectIds = Array.isArray(idJson.objectIds) ? idJson.objectIds : []
  objectIds.sort((a, b) => Number(a) - Number(b))

  const features = []
  for (let offset = 0; offset < objectIds.length; offset += FETCH_PAGE_SIZE) {
    const ids = objectIds.slice(offset, offset + FETCH_PAGE_SIZE)
    features.push(...await queryLayerObjectIds(DA_LAYER_ID, ids))
    console.log(`Fetched ${features.length.toLocaleString()} / ${objectIds.length.toLocaleString()} BC DA features`)
  }

  return {
    type: 'FeatureCollection',
    features,
  }
}

async function queryLayerGeoJson(layerId, where, batchSize = FETCH_PAGE_SIZE) {
  const idParams = new URLSearchParams({
    where,
    returnIdsOnly: 'true',
    f: 'json',
  })
  const idJson = await fetchJson(`${SERVICE_BASE}/${layerId}/query?${idParams.toString()}`)
  const objectIds = Array.isArray(idJson.objectIds) ? idJson.objectIds : []
  objectIds.sort((a, b) => Number(a) - Number(b))

  const features = []
  for (let offset = 0; offset < objectIds.length; offset += batchSize) {
    const ids = objectIds.slice(offset, offset + batchSize)
    features.push(...await queryLayerObjectIds(layerId, ids))
  }

  return {
    type: 'FeatureCollection',
    features,
  }
}

async function queryLayerObjectIds(layerId, objectIds) {
  return queryLayerObjectIdsWithOptions(layerId, objectIds, {})
}

async function queryLayerObjectIdsWithOptions(layerId, objectIds, extraParams) {
  const params = new URLSearchParams({
    objectIds: objectIds.join(','),
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
  })
  Object.entries(extraParams).forEach(([key, value]) => params.set(key, String(value)))

  try {
    const json = await fetchJson(`${SERVICE_BASE}/${layerId}/query?${params.toString()}`)
    return Array.isArray(json.features) ? json.features : []
  } catch (error) {
    if (objectIds.length === 1 && !extraParams.geometryPrecision) {
      return queryLayerObjectIdsWithOptions(layerId, objectIds, {
        geometryPrecision: 7,
      })
    }
    if (objectIds.length <= 1) throw error
    const midpoint = Math.ceil(objectIds.length / 2)
    const [left, right] = await Promise.all([
      queryLayerObjectIds(layerId, objectIds.slice(0, midpoint)),
      queryLayerObjectIds(layerId, objectIds.slice(midpoint)),
    ])
    return [...left, ...right]
  }
}

async function fetchParentBoundaries() {
  const entries = await Promise.all(PARENT_LAYER_DEFS.map(async (definition) => {
    console.log(`Fetching BC ${definition.label} boundaries...`)
    const collection = await queryLayerGeoJson(definition.layerId, `PRUID='${BC_PRUID}'`, PARENT_FETCH_PAGE_SIZE)
    console.log(`  ${collection.features.length.toLocaleString()} ${definition.level.toUpperCase()} features`)
    return [definition.level, collection]
  }))

  return Object.fromEntries(entries)
}

async function loadSource(sourcePath) {
  if (sourcePath) {
    return JSON.parse(await fs.readFile(path.resolve(sourcePath), 'utf8'))
  }

  try {
    return JSON.parse(await fs.readFile(defaultSourcePath, 'utf8'))
  } catch {
    await fs.mkdir(tmpDir, { recursive: true })
    const source = await fetchBcDaSource()
    await fs.writeFile(defaultSourcePath, JSON.stringify(source))
    return source
  }
}

async function loadParentBoundaries() {
  try {
    return JSON.parse(await fs.readFile(defaultParentsPath, 'utf8'))
  } catch {
    await fs.mkdir(tmpDir, { recursive: true })
    const parents = await fetchParentBoundaries()
    await fs.writeFile(defaultParentsPath, JSON.stringify(parents))
    return parents
  }
}

function toNumber(value) {
  if (value == null) return null
  const parsed = Number.parseFloat(String(value).replace(/,/g, '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

function countCoordinates(geometry) {
  if (!geometry) return 0
  if (geometry.type === 'Point') return 1
  if (geometry.type === 'MultiPoint' || geometry.type === 'LineString') return geometry.coordinates.length
  if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') {
    return geometry.coordinates.reduce((sum, ring) => sum + ring.length, 0)
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.reduce((sum, polygon) => (
      sum + polygon.reduce((ringSum, ring) => ringSum + ring.length, 0)
    ), 0)
  }
  return 0
}

function byteStats(json) {
  const text = JSON.stringify(json)
  return {
    rawBytes: Buffer.byteLength(text),
    gzipBytes: gzipSync(text).byteLength,
    text,
  }
}

function bboxContainsPoint(bboxValue, point) {
  const [lon, lat] = point.geometry.coordinates
  return lon >= bboxValue[0] && lon <= bboxValue[2] && lat >= bboxValue[1] && lat <= bboxValue[3]
}

function bboxesOverlap(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

function createParentRecord(rawFeature, definition) {
  if (!rawFeature?.geometry || (rawFeature.geometry.type !== 'Polygon' && rawFeature.geometry.type !== 'MultiPolygon')) {
    return null
  }

  const properties = rawFeature.properties ?? {}
  const id = String(properties[definition.idKey] ?? '').trim()
  if (!id) return null
  const name = String(properties[definition.nameKey] ?? id).trim() || id
  const type = definition.typeKey ? String(properties[definition.typeKey] ?? '').trim() || null : null
  const landArea = toNumber(properties.LANDAREA)

  return {
    id,
    name,
    type,
    level: definition.level,
    dguid: properties.DGUID ?? null,
    landArea,
    feature: rawFeature,
    bbox: turf.bbox(rawFeature),
  }
}

function createParentIndex(parentBoundaries) {
  return Object.fromEntries(PARENT_LAYER_DEFS.map((definition) => {
    const collection = parentBoundaries[definition.level]
    const records = (Array.isArray(collection?.features) ? collection.features : [])
      .map((feature) => createParentRecord(feature, definition))
      .filter(Boolean)
    return [definition.level, records]
  }))
}

function findContainingParent(point, feature, parentRecords) {
  const candidates = parentRecords.filter((record) => bboxContainsPoint(record.bbox, point))
  for (const record of candidates) {
    if (turf.booleanPointInPolygon(point, record.feature, { ignoreBoundary: false })) {
      return record
    }
  }

  const featureBbox = turf.bbox(feature)
  const intersecting = parentRecords.filter((record) => bboxesOverlap(record.bbox, featureBbox))
  for (const record of intersecting) {
    try {
      if (turf.booleanIntersects(feature, record.feature)) return record
    } catch {
      // Fall through to the next candidate.
    }
  }

  return null
}

function createDaHierarchy(sourceFeatures, parentIndex) {
  const hierarchyByDaUid = new Map()
  let missingCd = 0
  let missingCsd = 0
  let missingCt = 0

  for (const feature of sourceFeatures) {
    if (!feature?.geometry) continue
    const daUid = String(feature.properties?.DAUID ?? feature.properties?.id ?? feature.id ?? '').trim()
    if (!daUid) continue

    const point = turf.pointOnFeature(feature)
    const cd = findContainingParent(point, feature, parentIndex.cd ?? [])
    const csd = findContainingParent(point, feature, parentIndex.csd ?? [])
    const ct = findContainingParent(point, feature, parentIndex.ct ?? [])

    if (!cd) missingCd += 1
    if (!csd) missingCsd += 1
    if (!ct) missingCt += 1

    hierarchyByDaUid.set(daUid, { cd, csd, ct })
  }

  console.log(`Hierarchy join: ${hierarchyByDaUid.size.toLocaleString()} DA features`)
  console.log(`  Missing CD: ${missingCd.toLocaleString()}`)
  console.log(`  Missing CSD: ${missingCsd.toLocaleString()}`)
  console.log(`  Missing CT: ${missingCt.toLocaleString()} (expected outside tracted areas)`)

  return hierarchyByDaUid
}

function normalizeFeature(rawFeature, lodId, hierarchyByDaUid) {
  if (!rawFeature?.geometry || (rawFeature.geometry.type !== 'Polygon' && rawFeature.geometry.type !== 'MultiPolygon')) {
    return null
  }

  const properties = rawFeature.properties ?? {}
  const daUid = String(properties.DAUID ?? properties.id ?? rawFeature.id ?? '').trim()
  if (!daUid) return null

  const hierarchy = hierarchyByDaUid.get(daUid) ?? {}
  const areaKm2 = turf.area(rawFeature) / 1_000_000
  const normalized = {
    ...rawFeature,
    properties: {
      id: daUid,
      boundaryCode: daUid,
      boundaryName: `DA ${daUid}`,
      boundarySource: 'census',
      boundaryLevel: 'bcDaSimplified',
      boundaryDetail: lodId,
      DAUID: daUid,
      DGUID: properties.DGUID ?? null,
      PRUID: properties.PRUID ?? BC_PRUID,
      CDUID: hierarchy.cd?.id ?? properties.CDUID ?? null,
      CDNAME: hierarchy.cd?.name ?? properties.CDNAME ?? null,
      CDTYPE: hierarchy.cd?.type ?? properties.CDTYPE ?? null,
      CSDUID: hierarchy.csd?.id ?? properties.CSDUID ?? null,
      CSDNAME: hierarchy.csd?.name ?? properties.CSDNAME ?? null,
      CSDTYPE: hierarchy.csd?.type ?? properties.CSDTYPE ?? null,
      CTUID: hierarchy.ct?.id ?? properties.CTUID ?? null,
      CTNAME: hierarchy.ct?.name ?? properties.CTNAME ?? null,
      parentCdId: hierarchy.cd?.id ?? null,
      parentCdName: hierarchy.cd?.name ?? null,
      parentCsdId: hierarchy.csd?.id ?? null,
      parentCsdName: hierarchy.csd?.name ?? null,
      parentCtId: hierarchy.ct?.id ?? null,
      parentCtName: hierarchy.ct?.name ?? null,
      LANDAREA: toNumber(properties.LANDAREA),
      areaKm2: Number.isFinite(areaKm2) && areaKm2 > 0 ? areaKm2 : 0,
    },
  }

  return normalized
}

function createChunks(features, gridCols, gridRows) {
  const provinceBbox = turf.bbox({
    type: 'FeatureCollection',
    features,
  })
  const [west, south, east, north] = provinceBbox
  const cellWidth = (east - west) / gridCols
  const cellHeight = (north - south) / gridRows
  const chunks = new Map()

  for (const feature of features) {
    const featureBbox = turf.bbox(feature)
    const centerLon = (featureBbox[0] + featureBbox[2]) / 2
    const centerLat = (featureBbox[1] + featureBbox[3]) / 2
    const col = Math.max(0, Math.min(gridCols - 1, Math.floor((centerLon - west) / cellWidth)))
    const row = Math.max(0, Math.min(gridRows - 1, Math.floor((centerLat - south) / cellHeight)))
    const id = `r${row}-c${col}`

    const chunk = chunks.get(id) ?? {
      id,
      row,
      col,
      bbox: [featureBbox[0], featureBbox[1], featureBbox[2], featureBbox[3]],
      features: [],
    }

    chunk.bbox = [
      Math.min(chunk.bbox[0], featureBbox[0]),
      Math.min(chunk.bbox[1], featureBbox[1]),
      Math.max(chunk.bbox[2], featureBbox[2]),
      Math.max(chunk.bbox[3], featureBbox[3]),
    ]
    chunk.features.push(feature)
    chunks.set(id, chunk)
  }

  return [...chunks.values()].sort((a, b) => a.row - b.row || a.col - b.col)
}

function normalizeParentBoundary(rawFeature, definition) {
  const record = createParentRecord(rawFeature, definition)
  if (!record) return null

  const feature = structuredClone(rawFeature)
  if (!feature.geometry || (feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon')) {
    return null
  }

  const areaKm2 = turf.area(feature) / 1_000_000
  feature.properties = {
    id: record.id,
    boundaryId: `census:${definition.level}:${record.id}`,
    boundaryCode: record.id,
    boundaryName: record.name,
    boundarySource: 'census',
    boundaryLevel: definition.level,
    boundaryType: record.type,
    DGUID: record.dguid,
    LANDAREA: record.landArea,
    areaKm2: Number.isFinite(areaKm2) && areaKm2 > 0 ? areaKm2 : 0,
  }
  return feature
}

async function writeParentBoundaries(parentBoundaries) {
  const parentsDir = path.join(outputDir, 'parents')
  await fs.mkdir(parentsDir, { recursive: true })
  const manifestEntries = []

  for (const definition of PARENT_LAYER_DEFS) {
    const collection = parentBoundaries[definition.level]
    const normalizedFeatures = (Array.isArray(collection?.features) ? collection.features : [])
      .map((feature) => normalizeParentBoundary(feature, definition))
      .filter(Boolean)
    const simplified = simplifyPolygonTopology({
      type: 'FeatureCollection',
      features: normalizedFeatures,
    }, {
      toleranceMetres: definition.toleranceMetres,
      topologyProfile: TOPOLOGY_PROFILES.PARTITION,
      sourceCrs: SOURCE_CRS,
      workingCrs: WORKING_CRS,
      outputCrs: OUTPUT_CRS,
      coordinatePrecision: COORDINATE_PRECISION,
      tempPrefix: `bc-census-${definition.level}-`,
    })
    const features = simplified.features
      .sort((a, b) => String(a.properties?.boundaryCode ?? '').localeCompare(String(b.properties?.boundaryCode ?? '')))
    const output = {
      type: 'FeatureCollection',
      features,
    }
    const stats = byteStats(output)
    const fileName = `${definition.level}.geojson`
    await fs.writeFile(path.join(parentsDir, fileName), stats.text)
    manifestEntries.push({
      level: definition.level,
      label: definition.label,
      path: `parents/${fileName}`,
      features: features.length,
      simplificationToleranceMetres: definition.toleranceMetres,
      rawBytes: stats.rawBytes,
      gzipBytes: stats.gzipBytes,
    })
  }

  return manifestEntries
}

async function writeLod(sourceFeatures, lod, gridCols, gridRows, hierarchyByDaUid) {
  console.log(`Building ${lod.id} LOD at ${lod.toleranceMetres} metre tolerance`)
  const normalizedFeatures = sourceFeatures
    .map((feature) => normalizeFeature(feature, lod.id, hierarchyByDaUid))
    .filter(Boolean)
  const simplified = simplifyPolygonTopology({
    type: 'FeatureCollection',
    features: normalizedFeatures,
  }, {
    toleranceMetres: lod.toleranceMetres,
    topologyProfile: TOPOLOGY_PROFILES.PARTITION,
    sourceCrs: SOURCE_CRS,
    workingCrs: WORKING_CRS,
    outputCrs: OUTPUT_CRS,
    coordinatePrecision: COORDINATE_PRECISION,
    tempPrefix: `bc-da-${lod.id}-`,
  })
  const features = simplified.features
    .sort((a, b) => String(a.properties?.DAUID ?? '').localeCompare(String(b.properties?.DAUID ?? '')))

  const chunksDir = path.join(outputDir, 'chunks', lod.id)
  await fs.mkdir(chunksDir, { recursive: true })

  const chunks = createChunks(features, gridCols, gridRows)
  const chunkManifest = []
  let rawBytes = 0
  let gzipBytes = 0

  for (const chunk of chunks) {
    const collection = {
      type: 'FeatureCollection',
      features: chunk.features,
    }
    const stats = byteStats(collection)
    rawBytes += stats.rawBytes
    gzipBytes += stats.gzipBytes

    const fileName = `bc-da-${chunk.id}.geojson`
    await fs.writeFile(path.join(chunksDir, fileName), stats.text)
    chunkManifest.push({
      id: chunk.id,
      path: `chunks/${lod.id}/${fileName}`,
      bbox: chunk.bbox,
      featureCount: chunk.features.length,
      rawBytes: stats.rawBytes,
      gzipBytes: stats.gzipBytes,
    })
  }

  console.log(`  ${features.length.toLocaleString()} features, ${chunks.length.toLocaleString()} chunks`)
  console.log(`  Raw: ${(rawBytes / 1024 / 1024).toFixed(2)} MiB`)
  console.log(`  Gzip: ${(gzipBytes / 1024 / 1024).toFixed(2)} MiB`)

  return {
    id: lod.id,
    label: lod.label,
    tolerance: lod.tolerance,
    simplificationToleranceMetres: lod.toleranceMetres,
    minZoom: lod.minZoom,
    maxZoom: lod.maxZoom,
    features: features.length,
    coordinateCount: features.reduce((sum, feature) => sum + countCoordinates(feature.geometry), 0),
    rawBytes,
    gzipBytes,
    chunks: chunkManifest,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const source = await loadSource(options.source)
  const parentBoundaries = await loadParentBoundaries()
  const sourceFeatures = Array.isArray(source.features) ? source.features : []
  console.log(`Loaded ${sourceFeatures.length.toLocaleString()} BC DA source features`)
  const parentIndex = createParentIndex(parentBoundaries)
  const hierarchyByDaUid = createDaHierarchy(sourceFeatures, parentIndex)

  await fs.rm(outputDir, { recursive: true, force: true })
  await fs.mkdir(outputDir, { recursive: true })
  const parentBoundaryManifest = await writeParentBoundaries(parentBoundaries)
  const levels = []

  for (const lod of options.lods) {
    levels.push(await writeLod(sourceFeatures, lod, options.gridCols, options.gridRows, hierarchyByDaUid))
  }

  const defaultLevel = levels[levels.length - 1]

  const manifest = {
    source: {
      name: 'Statistics Canada 2021 Cartographic Boundary File - Dissemination Areas',
      service: `${SERVICE_BASE}/${DA_LAYER_ID}`,
      where: `PRUID='${BC_PRUID}'`,
    },
    simplification: {
      sourceCrs: SOURCE_CRS,
      workingCrs: WORKING_CRS,
      outputCrs: OUTPUT_CRS,
      algorithm: 'Mapshaper shared-topology Ramer-Douglas-Peucker',
      topologyPreserving: true,
      mapshaperVersion: MAPSHAPER_VERSION,
      coordinatePrecision: COORDINATE_PRECISION,
    },
    tolerance: defaultLevel.tolerance,
    grid: {
      cols: options.gridCols,
      rows: options.gridRows,
    },
    features: defaultLevel.features,
    coordinateCount: defaultLevel.coordinateCount,
    rawBytes: defaultLevel.rawBytes,
    gzipBytes: defaultLevel.gzipBytes,
    chunks: defaultLevel.chunks,
    levels,
    parentBoundaries: parentBoundaryManifest,
  }

  await fs.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  console.log(`Wrote ${levels.length.toLocaleString()} BC DA LOD level(s)`)
  console.log(`Output: ${path.relative(process.cwd(), outputDir)}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
