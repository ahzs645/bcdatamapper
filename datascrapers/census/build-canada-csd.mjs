#!/usr/bin/env node
/* global Buffer, URLSearchParams, console, fetch, process */

import fs from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { classifyCsdNorthSouth, NORTH_SOUTH_CLASSIFICATION_URL } from './north-south-classification.mjs'

const SERVICE_BASE = 'https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer'
const CSD_LAYER_ID = 9
const CSD_SERVICE_URL = `${SERVICE_BASE}/${CSD_LAYER_ID}`
const PROVINCES_AND_TERRITORIES = [
  ['10', 'Newfoundland and Labrador'],
  ['11', 'Prince Edward Island'],
  ['12', 'Nova Scotia'],
  ['13', 'New Brunswick'],
  ['24', 'Quebec'],
  ['35', 'Ontario'],
  ['46', 'Manitoba'],
  ['47', 'Saskatchewan'],
  ['48', 'Alberta'],
  ['59', 'British Columbia'],
  ['60', 'Yukon'],
  ['61', 'Northwest Territories'],
  ['62', 'Nunavut'],
]
const FETCH_PAGE_SIZE = 250
// Keep the source snapshot unsimplified. Applying maxAllowableOffset here lets
// ArcGIS generalize every polygon separately, which permanently introduces
// gaps and overlaps before the shared-topology build sees the data.
const GEOMETRY_PRECISION = 7

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outputDir = path.join(__dirname, 'output', 'canada-csd')

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Request failed (${response.status}) for ${url}\n${body.slice(0, 500)}`)
  }
  const json = await response.json()
  if (json.error) {
    throw new Error(`ArcGIS query failed for ${url}: ${JSON.stringify(json.error)}`)
  }
  return json
}

async function fetchObjectIds(prUid) {
  const params = new URLSearchParams({
    where: `PRUID='${prUid}'`,
    returnIdsOnly: 'true',
    f: 'json',
  })
  const json = await fetchJson(`${CSD_SERVICE_URL}/query?${params.toString()}`)
  return (Array.isArray(json.objectIds) ? json.objectIds : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
}

async function queryObjectIds(objectIds, extraParams = {}) {
  const params = new URLSearchParams({
    objectIds: objectIds.join(','),
    outFields: 'CSDUID,DGUID,CSDNAME,CSDTYPE,LANDAREA,PRUID',
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: String(GEOMETRY_PRECISION),
    f: 'geojson',
  })
  Object.entries(extraParams).forEach(([key, value]) => params.set(key, String(value)))

  try {
    const json = await fetchJson(`${CSD_SERVICE_URL}/query?${params.toString()}`)
    return Array.isArray(json.features) ? json.features : []
  } catch (error) {
    if (objectIds.length === 1 && !extraParams.maxAllowableOffset) {
      // Statistics Canada's largest Nunavut geometry exceeds the ArcGIS
      // response limit at full detail. Use the smallest offset that the
      // service accepts, then snap this sub-25 m discrepancy when the complete
      // national coverage is processed by Mapshaper.
      return queryObjectIds(objectIds, { maxAllowableOffset: 0.0002 })
    }
    if (objectIds.length <= 1) throw error
    const midpoint = Math.ceil(objectIds.length / 2)
    const [left, right] = await Promise.all([
      queryObjectIds(objectIds.slice(0, midpoint)),
      queryObjectIds(objectIds.slice(midpoint)),
    ])
    return [...left, ...right]
  }
}

async function fetchProvince(prUid, name) {
  const objectIds = await fetchObjectIds(prUid)
  const features = []
  for (let offset = 0; offset < objectIds.length; offset += FETCH_PAGE_SIZE) {
    const batch = objectIds.slice(offset, offset + FETCH_PAGE_SIZE)
    features.push(...(await queryObjectIds(batch)))
    console.log(`  ${name}: ${features.length.toLocaleString()} / ${objectIds.length.toLocaleString()}`)
  }
  return features
}

function normalizeFeature(rawFeature) {
  if (
    !rawFeature?.geometry ||
    (rawFeature.geometry.type !== 'Polygon' && rawFeature.geometry.type !== 'MultiPolygon')
  ) {
    return null
  }

  const sourceProperties = rawFeature.properties ?? {}
  const csdUid = String(sourceProperties.CSDUID ?? '').trim()
  if (!/^\d{7}$/.test(csdUid)) return null
  const csdName = String(sourceProperties.CSDNAME ?? csdUid).trim() || csdUid
  const landArea = Number(sourceProperties.LANDAREA)
  const northSouth = classifyCsdNorthSouth(csdUid)

  return {
    type: 'Feature',
    geometry: rawFeature.geometry,
    properties: {
      id: csdUid,
      boundaryId: `census:csd:${csdUid}`,
      boundaryCode: csdUid,
      boundaryName: csdName,
      boundarySource: 'census',
      boundaryLevel: 'csd',
      CSDUID: csdUid,
      CSDNAME: csdName,
      CSDTYPE: sourceProperties.CSDTYPE ?? null,
      CDUID: csdUid.slice(0, 4),
      PRUID: csdUid.slice(0, 2),
      DGUID: sourceProperties.DGUID ?? null,
      LANDAREA: Number.isFinite(landArea) ? landArea : null,
      areaKm2: Number.isFinite(landArea) ? landArea : 0,
      north_south: northSouth,
      north_south_code: northSouth === 'North' ? 'N' : 'S',
    },
  }
}

function extendBboxWithCoordinates(bbox, coordinates) {
  if (typeof coordinates[0] === 'number') {
    bbox[0] = Math.min(bbox[0], coordinates[0])
    bbox[1] = Math.min(bbox[1], coordinates[1])
    bbox[2] = Math.max(bbox[2], coordinates[0])
    bbox[3] = Math.max(bbox[3], coordinates[1])
    return
  }
  for (const nested of coordinates) {
    extendBboxWithCoordinates(bbox, nested)
  }
}

function featureCollectionBbox(features) {
  const bbox = [Infinity, Infinity, -Infinity, -Infinity]
  for (const feature of features) {
    extendBboxWithCoordinates(bbox, feature.geometry.coordinates)
  }
  return bbox.map((value) => Number(value.toFixed(GEOMETRY_PRECISION)))
}

async function main() {
  const resume = process.argv.includes('--resume')
  if (!resume) await fs.rm(outputDir, { recursive: true, force: true })
  await fs.mkdir(path.join(outputDir, 'provinces'), { recursive: true })

  const allFeatures = []
  const chunks = []
  let northCount = 0
  let southCount = 0

  for (const [prUid, name] of PROVINCES_AND_TERRITORIES) {
    const fileName = `${prUid}.geojson.gz`
    const provincePath = path.join(outputDir, 'provinces', fileName)
    let features
    if (resume) {
      try {
        const existing = JSON.parse(gunzipSync(await fs.readFile(provincePath)).toString('utf8'))
        features = existing.features
        console.log(`Reusing ${features.length.toLocaleString()} ${name} CSD boundaries...`)
      } catch {
        try {
          const legacyPath = path.join(outputDir, 'provinces', `${prUid}.geojson`)
          const existing = JSON.parse(await fs.readFile(legacyPath, 'utf8'))
          features = existing.features
          console.log(`Compressing ${features.length.toLocaleString()} existing ${name} CSD boundaries...`)
        } catch {
          // Fetch below when no valid resumable snapshot exists.
        }
      }
    }
    if (!features) {
      console.log(`Fetching ${name} CSD boundaries...`)
      features = (await fetchProvince(prUid, name))
        .map(normalizeFeature)
        .filter(Boolean)
        .sort((a, b) => a.properties.CSDUID.localeCompare(b.properties.CSDUID))
    }
    const collection = { type: 'FeatureCollection', features }
    const text = JSON.stringify(collection)
    const compressed = gzipSync(text, { level: 9 })
    await fs.writeFile(provincePath, compressed)

    const chunkNorthCount = features.filter(
      (feature) => feature.properties.north_south === 'North',
    ).length
    const chunkSouthCount = features.length - chunkNorthCount
    northCount += chunkNorthCount
    southCount += chunkSouthCount
    allFeatures.push(...features)
    chunks.push({
      id: prUid,
      name,
      path: `provinces/${fileName}`,
      bbox: featureCollectionBbox(features),
      features: features.length,
      north: chunkNorthCount,
      south: chunkSouthCount,
      rawBytes: Buffer.byteLength(text),
      gzipBytes: compressed.byteLength,
    })
  }

  allFeatures.sort((a, b) => a.properties.CSDUID.localeCompare(b.properties.CSDUID))
  const byCsdUid = Object.fromEntries(
    allFeatures.map((feature) => [
      feature.properties.CSDUID,
      classifyCsdNorthSouth(feature.properties.CSDUID),
    ]),
  )
  const classification = {
    name: 'Variant of Standard Geographical Classification (SGC) 2021 for North and South',
    url: NORTH_SOUTH_CLASSIFICATION_URL,
    joinField: 'CSDUID',
    field: 'north_south',
    values: ['North', 'South'],
    features: allFeatures.length,
    north: northCount,
    south: southCount,
    byCsdUid,
  }
  await fs.writeFile(
    path.join(outputDir, 'north-south.json'),
    `${JSON.stringify(classification, null, 2)}\n`,
  )

  const manifest = {
    name: '2021 Census Subdivisions',
    source: {
      name: 'Statistics Canada 2021 Cartographic Boundary File - Census Subdivisions',
      service: CSD_SERVICE_URL,
      boundaryQuery: {
        topologySimplification: null,
        geometryPrecision: GEOMETRY_PRECISION,
        exceptionalFallback: {
          reason: 'ArcGIS response limit for one large Nunavut geometry',
          maxAllowableOffset: 0.0002,
        },
      },
    },
    classification: {
      path: 'north-south.json',
      joinField: 'CSDUID',
      field: 'north_south',
    },
    features: allFeatures.length,
    north: northCount,
    south: southCount,
    rawBytes: chunks.reduce((sum, chunk) => sum + chunk.rawBytes, 0),
    gzipBytes: chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
    chunks,
  }

  await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(
    `Wrote ${allFeatures.length.toLocaleString()} CSDs (${northCount.toLocaleString()} North, ${southCount.toLocaleString()} South)`,
  )
  console.log(`Output: ${path.relative(process.cwd(), outputDir)}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
