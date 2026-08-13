#!/usr/bin/env node
/* global console, process */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output')
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function validateFeature(feature, datasetId, ids) {
  assert(feature?.type === 'Feature', `${datasetId}: non-Feature entry`)
  assert(
    feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon',
    `${datasetId}: unsupported or missing geometry`,
  )
  const id = String(feature.properties?.id ?? '')
  assert(id, `${datasetId}: missing normalized id`)
  assert(!ids.has(id), `${datasetId}: duplicate normalized id ${id}`)
  ids.add(id)
  assert(feature.properties?.boundaryName, `${datasetId}: ${id} missing boundaryName`)
  assert(feature.properties?.boundarySource, `${datasetId}: ${id} missing boundarySource`)
  assert(feature.properties?.representationRole, `${datasetId}: ${id} missing representationRole`)
}

async function validateFile(datasetId, file) {
  const inputPath = path.join(OUTPUT_DIR, file.path)
  const compressed = await fs.readFile(inputPath)
  assert(compressed.byteLength === file.gzipBytes, `${datasetId}: gzip byte count mismatch for ${file.path}`)
  assert(sha256(compressed) === file.sha256, `${datasetId}: SHA-256 mismatch for ${file.path}`)
  const collection = JSON.parse(gunzipSync(compressed).toString('utf8'))
  assert(collection.type === 'FeatureCollection', `${datasetId}: ${file.path} is not a FeatureCollection`)
  assert(collection.features.length === file.features, `${datasetId}: feature count mismatch for ${file.path}`)
  return collection.features
}

async function validateDataset(datasetId, dataset) {
  const files = Array.isArray(dataset.chunks) ? dataset.chunks : [dataset]
  const ids = new Set()
  let features = 0
  for (const file of files) {
    const fileFeatures = await validateFile(datasetId, file)
    for (const feature of fileFeatures) validateFeature(feature, datasetId, ids)
    features += fileFeatures.length
  }
  const declaredFeatures = dataset.features ?? dataset.sourceFeatureCount
  assert(features === declaredFeatures, `${datasetId}: declared ${declaredFeatures} features but read ${features}`)
  return features
}

async function validateLayerGroup(datasetId, group) {
  let count = 0
  for (const [layerId, layer] of Object.entries(group.layers)) {
    const fileFeatures = await validateFile(`${datasetId}.${layerId}`, layer)
    const ids = new Set()
    for (const feature of fileFeatures) validateFeature(feature, `${datasetId}.${layerId}`, ids)
    count += fileFeatures.length
  }
  return count
}

async function validateOverview(datasetId, expectedFeatures, fileName) {
  const inputPath = path.join(OUTPUT_DIR, 'overview', fileName)
  const collection = JSON.parse(await fs.readFile(inputPath, 'utf8'))
  assert(collection.type === 'FeatureCollection', `${datasetId} overview is not a FeatureCollection`)
  assert(
    collection.features.length === expectedFeatures,
    `${datasetId} overview feature count mismatch: ${collection.features.length} != ${expectedFeatures}`,
  )
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'))
  assert(manifest.schemaVersion === 1, 'Unsupported manifest schema')
  assert(manifest.complete === true, 'Manifest is not marked complete')

  const csdCount = await validateDataset('censusSubdivisions2025', manifest.datasets.censusSubdivisions2025)
  const cdCount = await validateDataset('censusDivisions2021', manifest.datasets.censusDivisions2021)
  const indigenousCount = await validateDataset('indigenousLandsClss', manifest.datasets.indigenousLandsClss)
  const nlCount = await validateLayerGroup('newfoundlandLabrador', manifest.datasets.newfoundlandLabrador)

  assert(csdCount === 5054, `Expected 5,054 2025 CSDs, found ${csdCount}`)
  assert(cdCount === 293, `Expected 293 2021 CDs, found ${cdCount}`)
  assert(indigenousCount >= 3300, `Expected at least 3,300 CLSS Indigenous land features, found ${indigenousCount}`)
  assert(nlCount === 256, `Expected 256 Newfoundland and Labrador source features, found ${nlCount}`)

  await validateOverview('censusSubdivisions2025', csdCount, 'census-subdivisions-2025.geojson')
  await validateOverview('censusDivisions2021', cdCount, 'census-divisions-2021.geojson')
  await validateOverview('indigenousLandsClss', indigenousCount, 'indigenous-lands-clss.geojson')
  await validateOverview('censusDivisions2025Derived', 290, 'census-divisions-2025-derived.geojson')

  const glossaryFile = manifest.datasets.statcanTypeGlossary
  const glossaryPath = path.join(OUTPUT_DIR, glossaryFile.path)
  const glossaryBuffer = await fs.readFile(glossaryPath)
  assert(glossaryBuffer.byteLength === glossaryFile.bytes, 'Type glossary byte count mismatch')
  assert(sha256(glossaryBuffer) === glossaryFile.sha256, 'Type glossary SHA-256 mismatch')
  const glossary = JSON.parse(glossaryBuffer.toString('utf8'))
  assert(glossary.censusSubdivisionTypes.length >= 50, 'Type glossary has too few CSD types')
  assert(glossary.censusDivisionTypes.length >= 10, 'Type glossary has too few CD types')

  console.log(
    `Canada administrative-geographies validation passed: ` +
      `${csdCount.toLocaleString()} CSDs, ${cdCount.toLocaleString()} CDs, ` +
      `${indigenousCount.toLocaleString()} Indigenous land features.`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
