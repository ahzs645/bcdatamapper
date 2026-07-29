#!/usr/bin/env node
/* global Buffer, URLSearchParams, console, fetch, process */

import fs from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
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
const MAX_ALLOWABLE_OFFSET = 0.002
const GEOMETRY_PRECISION = 5

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

async function queryObjectIds(objectIds) {
  const params = new URLSearchParams({
    objectIds: objectIds.join(','),
    outFields: 'CSDUID,DGUID,CSDNAME,CSDTYPE,LANDAREA,PRUID',
    returnGeometry: 'true',
    outSR: '4326',
    maxAllowableOffset: String(MAX_ALLOWABLE_OFFSET),
    geometryPrecision: String(GEOMETRY_PRECISION),
    f: 'geojson',
  })

  try {
    const json = await fetchJson(`${CSD_SERVICE_URL}/query?${params.toString()}`)
    return Array.isArray(json.features) ? json.features : []
  } catch (error) {
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
    },
  }
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value))
}

async function main() {
  await fs.rm(outputDir, { recursive: true, force: true })
  await fs.mkdir(path.join(outputDir, 'provinces'), { recursive: true })

  const allFeatures = []
  const chunks = []
  let northCount = 0
  let southCount = 0

  for (const [prUid, name] of PROVINCES_AND_TERRITORIES) {
    console.log(`Fetching ${name} CSD boundaries...`)
    const features = (await fetchProvince(prUid, name))
      .map(normalizeFeature)
      .filter(Boolean)
      .sort((a, b) => a.properties.CSDUID.localeCompare(b.properties.CSDUID))
    const collection = { type: 'FeatureCollection', features }
    const text = JSON.stringify(collection)
    const fileName = `${prUid}.geojson`
    await fs.writeFile(path.join(outputDir, 'provinces', fileName), text)

    const chunkNorthCount = features.filter(
      (feature) => classifyCsdNorthSouth(feature.properties.CSDUID) === 'North',
    ).length
    const chunkSouthCount = features.length - chunkNorthCount
    northCount += chunkNorthCount
    southCount += chunkSouthCount
    allFeatures.push(...features)
    chunks.push({
      id: prUid,
      name,
      path: `provinces/${fileName}`,
      features: features.length,
      north: chunkNorthCount,
      south: chunkSouthCount,
      rawBytes: Buffer.byteLength(text),
      gzipBytes: gzipSync(text, { level: 9 }).byteLength,
    })
  }

  allFeatures.sort((a, b) => a.properties.CSDUID.localeCompare(b.properties.CSDUID))
  const completeCollection = { type: 'FeatureCollection', features: allFeatures }
  const completeText = JSON.stringify(completeCollection)
  const completeGzip = gzipSync(completeText, { level: 9 })
  await fs.writeFile(path.join(outputDir, 'canada-csd.geojson.gz'), completeGzip)

  const byCsdUid = Object.fromEntries(
    allFeatures.map((feature) => [
      feature.properties.CSDUID,
      classifyCsdNorthSouth(feature.properties.CSDUID),
    ]),
  )
  const classification = {
    generatedAt: new Date().toISOString(),
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
    generatedAt: new Date().toISOString(),
    name: '2021 Census Subdivisions',
    source: {
      name: 'Statistics Canada 2021 Cartographic Boundary File - Census Subdivisions',
      service: CSD_SERVICE_URL,
      boundaryQuery: {
        maxAllowableOffset: MAX_ALLOWABLE_OFFSET,
        geometryPrecision: GEOMETRY_PRECISION,
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
    rawBytes: byteLength(completeCollection),
    gzipBytes: completeGzip.byteLength,
    completeArchive: 'canada-csd.geojson.gz',
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
