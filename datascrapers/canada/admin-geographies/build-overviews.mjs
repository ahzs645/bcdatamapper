#!/usr/bin/env node
/* global Buffer, console, process */

import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import {
  MAPSHAPER_VERSION,
  simplifyPolygonTopology,
  TOPOLOGY_PROFILES,
} from '../../lib/mapshaper-topology.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output')
const OVERVIEW_DIR = path.join(OUTPUT_DIR, 'overview')
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')
const SOURCE_CRS = 'EPSG:4326'
const WORKING_CRS = 'EPSG:3978'
const OUTPUT_CRS = 'EPSG:4326'
const COORDINATE_PRECISION = 6

const OVERVIEWS = [
  {
    id: 'censusSubdivisions2025',
    output: 'census-subdivisions-2025.geojson',
    toleranceMetres: 250,
    topologyProfile: TOPOLOGY_PROFILES.PARTITION,
    sortProperty: 'CSDUID',
  },
  {
    id: 'censusDivisions2021',
    output: 'census-divisions-2021.geojson',
    toleranceMetres: 500,
    topologyProfile: TOPOLOGY_PROFILES.PARTITION,
    sortProperty: 'CDUID',
  },
  {
    id: 'indigenousLandsClss',
    output: 'indigenous-lands-clss.geojson',
    toleranceMetres: 100,
    topologyProfile: TOPOLOGY_PROFILES.OVERLAP,
    sortProperty: 'adminAreaId',
  },
]

const ifMissing = process.argv.includes('--if-missing')

function countVertices(features) {
  let count = 0
  function visit(value) {
    if (!Array.isArray(value)) return
    if (typeof value[0] === 'number') {
      count += 1
      return
    }
    for (const nested of value) visit(nested)
  }
  for (const feature of features) visit(feature.geometry?.coordinates)
  return count
}

async function readGzipCollection(inputPath) {
  const buffer = await fs.readFile(inputPath)
  return JSON.parse(gunzipSync(buffer).toString('utf8'))
}

async function readSourceFeatures(dataset) {
  if (Array.isArray(dataset.chunks)) {
    const features = []
    for (const chunk of dataset.chunks) {
      const collection = await readGzipCollection(path.join(OUTPUT_DIR, chunk.path))
      features.push(...collection.features)
    }
    return features
  }
  const collection = await readGzipCollection(path.join(OUTPUT_DIR, dataset.path))
  return collection.features
}

async function shouldSkip(outputPath) {
  if (!ifMissing) return false
  try {
    const [outputStat, manifestStat] = await Promise.all([
      fs.stat(outputPath),
      fs.stat(MANIFEST_PATH),
    ])
    return outputStat.mtimeMs >= manifestStat.mtimeMs
  } catch {
    return false
  }
}

async function buildOverview(config, dataset) {
  const outputPath = path.join(OVERVIEW_DIR, config.output)
  if (await shouldSkip(outputPath)) {
    console.log(`[canada-admin-overview] up to date: ${path.relative(process.cwd(), outputPath)}`)
    return
  }

  const sourceFeatures = await readSourceFeatures(dataset)
  const sourceVertices = countVertices(sourceFeatures)
  const simplified = simplifyPolygonTopology(
    { type: 'FeatureCollection', features: sourceFeatures },
    {
      toleranceMetres: config.toleranceMetres,
      topologyProfile: config.topologyProfile,
      sourceCrs: SOURCE_CRS,
      workingCrs: WORKING_CRS,
      outputCrs: OUTPUT_CRS,
      coordinatePrecision: COORDINATE_PRECISION,
      tempPrefix: `canada-admin-${config.id}-`,
    },
  )
  const features = simplified.features.sort((left, right) =>
    String(left.properties?.[config.sortProperty] ?? '').localeCompare(
      String(right.properties?.[config.sortProperty] ?? ''),
    ),
  )
  if (features.length !== sourceFeatures.length) {
    throw new Error(`${config.id} overview changed feature count: ${sourceFeatures.length} -> ${features.length}`)
  }

  const collection = {
    type: 'FeatureCollection',
    metadata: {
      ...simplified.metadata,
      dataset: config.id,
      sourceFeatureCount: sourceFeatures.length,
      mapshaperVersion: MAPSHAPER_VERSION,
    },
    features,
  }
  const text = JSON.stringify(collection)
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, text)
  console.log(
    `[canada-admin-overview] ${config.id}: ` +
      `${features.length.toLocaleString()} features, ` +
      `${sourceVertices.toLocaleString()} -> ${countVertices(features).toLocaleString()} vertices, ` +
      `${(Buffer.byteLength(text) / 2 ** 20).toFixed(1)} MiB raw / ` +
      `${(gzipSync(text, { level: 9 }).byteLength / 2 ** 20).toFixed(1)} MiB gzip`,
  )
}

async function buildCurrentCensusDivisions() {
  const sourcePath = path.join(OVERVIEW_DIR, 'census-subdivisions-2025.geojson')
  const outputPath = path.join(OVERVIEW_DIR, 'census-divisions-2025-derived.geojson')
  if (await shouldSkip(outputPath)) {
    console.log(`[canada-admin-overview] up to date: ${path.relative(process.cwd(), outputPath)}`)
    return
  }

  const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'canada-admin-current-cd-'))
  const dissolvedPath = path.join(tempDir, 'dissolved.geojson')
  try {
    execFileSync(
      'npx',
      [
        '--yes',
        '--package',
        `mapshaper@${MAPSHAPER_VERSION}`,
        '--',
        'mapshaper',
        sourcePath,
        '-dissolve2',
        'CDUID',
        'copy-fields=CDNAME,CDTYPE,PRUID,PRNAME',
        '-o',
        'force',
        'format=geojson',
        'precision=0.000001',
        dissolvedPath,
      ],
      { stdio: 'inherit', maxBuffer: 1024 * 1024 * 128 },
    )
    const dissolved = JSON.parse(await fs.readFile(dissolvedPath, 'utf8'))
    const features = dissolved.features
      .filter((feature) => feature.properties?.CDUID && feature.geometry)
      .map((feature) => {
        const properties = feature.properties
        const uid = String(properties.CDUID)
        const name = String(properties.CDNAME ?? uid)
        return {
          type: 'Feature',
          geometry: feature.geometry,
          properties: {
            id: `statcan:cd:2025-derived:${uid}`,
            boundaryId: `statcan:cd:2025-derived:${uid}`,
            boundaryCode: uid,
            boundaryName: name,
            boundarySource: 'Statistics Canada 2025 Census Subdivision parent geography',
            boundaryLevel: 'census-division',
            referenceDate: '2025-01-01',
            representationRole: 'regional-government-or-statistical-equivalent',
            derivedFrom: 'census-subdivisions-2025',
            CDUID: uid,
            CDNAME: name,
            CDTYPE: properties.CDTYPE ?? null,
            PRUID: properties.PRUID ?? uid.slice(0, 2),
            PRNAME: properties.PRNAME ?? null,
          },
        }
      })
      .sort((left, right) => left.properties.CDUID.localeCompare(right.properties.CDUID))
    if (features.length !== 290) {
      throw new Error(`Expected 290 current 2025 CD parent geographies, found ${features.length}`)
    }
    await fs.writeFile(
      outputPath,
      JSON.stringify({
        type: 'FeatureCollection',
        metadata: {
          source: 'Statistics Canada 2025 Census Subdivision Boundary File',
          sourceMethod: 'Dissolved from CSD polygons on CDUID',
          referenceDate: '2025-01-01',
          features: features.length,
          mapshaperVersion: MAPSHAPER_VERSION,
        },
        features,
      }),
    )
    console.log(`[canada-admin-overview] current census divisions: ${features.length} features`)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'))
  for (const config of OVERVIEWS) {
    const dataset = manifest.datasets?.[config.id]
    if (!dataset) throw new Error(`Manifest is missing ${config.id}`)
    await buildOverview(config, dataset)
  }
  await buildCurrentCensusDivisions()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
