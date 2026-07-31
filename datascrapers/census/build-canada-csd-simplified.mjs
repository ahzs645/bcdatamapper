#!/usr/bin/env node
/* global Buffer, console, process */
// Derives a lightweight national census-subdivision boundary file from the
// full-detail canada-csd output (see build-canada-csd.mjs), using the same
// pinned mapshaper pipeline as the BC boundary scrapers so shared borders are
// simplified topologically (no gaps or overlaps between neighbours).
//
// The output is a generated artifact: it is gitignored here and rebuilt on
// demand (PGMaps runs `census:canada-csd-simplified -- --if-missing` in
// predev/prebuild before the data sync), so the simplified copy is never
// committed alongside the full-detail snapshot.
//
// Pass --if-missing to skip the rebuild when the output is newer than every
// input; pass nothing to force a rebuild.

import fs from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import {
  MAPSHAPER_VERSION,
  simplifyPolygonTopology,
  TOPOLOGY_PROFILES,
} from '../lib/mapshaper-topology.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sourceDir = path.join(__dirname, 'output', 'canada-csd')
const manifestPath = path.join(sourceDir, 'manifest.json')
const outputPath = path.join(__dirname, 'output', 'canada-csd-simplified.geojson')
const sharedTopologyPath = fileURLToPath(new URL('../lib/mapshaper-topology.mjs', import.meta.url))

const SOURCE_CRS = 'EPSG:4326'
const WORKING_CRS = 'EPSG:3978'
const OUTPUT_CRS = 'EPSG:4326'
const SIMPLIFICATION_TOLERANCE_METRES = 200
const COORDINATE_PRECISION = 7

const KEEP_PROPERTIES = [
  'id',
  'boundaryId',
  'boundaryCode',
  'boundaryName',
  'boundarySource',
  'boundaryLevel',
  'CSDUID',
  'CSDNAME',
  'CSDTYPE',
  'CDUID',
  'PRUID',
  'areaKm2',
  'north_south',
  'north_south_code',
]

function countVertices(features) {
  let count = 0
  const visit = (coords) => {
    if (typeof coords[0] === 'number') {
      count += 1
      return
    }
    for (const entry of coords) visit(entry)
  }
  for (const feature of features) visit(feature.geometry.coordinates)
  return count
}

async function isUpToDate(inputPaths) {
  try {
    const outputStat = await fs.stat(outputPath)
    const inputStats = await Promise.all(inputPaths.map((inputPath) => fs.stat(inputPath)))
    return inputStats.every((stat) => stat.mtimeMs <= outputStat.mtimeMs)
  } catch {
    return false
  }
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const inputPaths = [
    manifestPath,
    fileURLToPath(import.meta.url),
    sharedTopologyPath,
    ...manifest.chunks.map((chunk) => path.join(sourceDir, chunk.path)),
  ]

  if (process.argv.includes('--if-missing') && (await isUpToDate(inputPaths))) {
    console.log(`[canada-csd-simplified] up to date: ${path.relative(process.cwd(), outputPath)}`)
    return
  }

  const sourceFeatures = []
  for (const chunk of manifest.chunks) {
    const chunkPath = path.join(sourceDir, chunk.path)
    const buffer = await fs.readFile(chunkPath)
    const collection = JSON.parse(
      chunk.path.endsWith('.gz') ? gunzipSync(buffer).toString('utf8') : buffer.toString('utf8'),
    )
    sourceFeatures.push(...collection.features)
  }
  const sourceVertices = countVertices(sourceFeatures)

  const simplified = simplifyPolygonTopology({ type: 'FeatureCollection', features: sourceFeatures }, {
    toleranceMetres: SIMPLIFICATION_TOLERANCE_METRES,
    topologyProfile: TOPOLOGY_PROFILES.PARTITION,
    sourceCrs: SOURCE_CRS,
    workingCrs: WORKING_CRS,
    outputCrs: OUTPUT_CRS,
    coordinatePrecision: COORDINATE_PRECISION,
    tempPrefix: 'canada-csd-simplified-',
  })
  const simplifiedFeatures = simplified.features
    .filter((feature) => feature.geometry && (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon'))
    .filter((feature) => feature.properties?.CSDUID)

  const outputUids = new Set(simplifiedFeatures.map((feature) => String(feature.properties.CSDUID)))
  const missingUids = sourceFeatures
    .map((feature) => String(feature.properties.CSDUID))
    .filter((uid) => !outputUids.has(uid))
  if (missingUids.length > 0 || simplifiedFeatures.length !== sourceFeatures.length) {
    throw new Error(`Shared-topology output lost ${missingUids.length} CSDs: ${missingUids.slice(0, 20).join(', ')}`)
  }

  const features = simplifiedFeatures
      .map((feature) => {
        const properties = {}
        for (const key of KEEP_PROPERTIES) {
          if (feature.properties?.[key] != null) properties[key] = feature.properties[key]
        }
        return { type: 'Feature', geometry: feature.geometry, properties }
      })
      .sort((a, b) => String(a.properties.CSDUID).localeCompare(String(b.properties.CSDUID)))

  const text = JSON.stringify({
    type: 'FeatureCollection',
    metadata: {
      ...simplified.metadata,
      sourceCrs: SOURCE_CRS,
      workingCrs: WORKING_CRS,
      outputCrs: OUTPUT_CRS,
      simplification: 'Mapshaper shared-topology Ramer-Douglas-Peucker',
      simplificationToleranceMetres: SIMPLIFICATION_TOLERANCE_METRES,
      topologyPreserving: true,
      mapshaperVersion: MAPSHAPER_VERSION,
      coordinatePrecision: COORDINATE_PRECISION,
    },
    features,
  })
  await fs.writeFile(outputPath, text)

  const outputVertices = countVertices(features)
  const rawMiB = (Buffer.byteLength(text) / 1024 / 1024).toFixed(1)
  const gzipMiB = (gzipSync(text, { level: 9 }).byteLength / 1024 / 1024).toFixed(1)
  console.log(
    `[canada-csd-simplified] mapshaper@${MAPSHAPER_VERSION}: ` +
      `${features.length.toLocaleString()} / ${sourceFeatures.length.toLocaleString()} features, ` +
      `${sourceVertices.toLocaleString()} -> ${outputVertices.toLocaleString()} vertices, ` +
      `${rawMiB} MiB raw (${gzipMiB} MiB gzip) -> ${path.relative(process.cwd(), outputPath)}`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
