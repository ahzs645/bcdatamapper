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

import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sourceDir = path.join(__dirname, 'output', 'canada-csd')
const manifestPath = path.join(sourceDir, 'manifest.json')
const outputPath = path.join(__dirname, 'output', 'canada-csd-simplified.geojson')

const MAPSHAPER_VERSION = '0.6.113'
// Tuning knobs: lower the keep percentage or raise the island floor for a
// smaller file, raise/lower for more fidelity. The island floor is what
// removes the thousands of tiny coastal islands that dominate the full
// file's vertex count.
const SIMPLIFY_KEEP = '10%'
const MIN_ISLAND_AREA = '4km2'
const COORDINATE_PRECISION = 0.001

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

// Planar shoelace area in squared degrees — only used to rank rings by size,
// so the missing latitude correction is irrelevant.
function ringRankingArea(ring) {
  let sum = 0
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  }
  return Math.abs(sum / 2)
}

function roundRing(ring) {
  const rounded = []
  for (const [lng, lat] of ring) {
    const point = [Number(lng.toFixed(3)), Number(lat.toFixed(3))]
    const previous = rounded[rounded.length - 1]
    if (previous && previous[0] === point[0] && previous[1] === point[1]) continue
    rounded.push(point)
  }
  const first = rounded[0]
  const last = rounded[rounded.length - 1]
  if (first && (first[0] !== last[0] || first[1] !== last[1])) rounded.push([first[0], first[1]])
  return rounded.length >= 4 ? rounded : null
}

// mapshaper's -clean / -filter-islands can erase micro CSDs (tiny island
// communities) entirely; give those a minimal footprint from their largest
// source ring so every CSD stays searchable and selectable.
function fallbackFeature(sourceFeature) {
  const polygons = sourceFeature.geometry.type === 'Polygon'
    ? [sourceFeature.geometry.coordinates]
    : sourceFeature.geometry.coordinates
  const largestOuter = polygons
    .map((rings) => rings[0])
    .sort((a, b) => ringRankingArea(b) - ringRankingArea(a))[0]
  if (!largestOuter) return null
  const outer = roundRing(largestOuter) ?? largestOuter
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [outer] },
    properties: sourceFeature.properties,
  }
}

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
    ...manifest.chunks.map((chunk) => path.join(sourceDir, chunk.path)),
  ]

  if (process.argv.includes('--if-missing') && (await isUpToDate(inputPaths))) {
    console.log(`[canada-csd-simplified] up to date: ${path.relative(process.cwd(), outputPath)}`)
    return
  }

  const sourceFeatures = []
  for (const chunk of manifest.chunks) {
    const collection = JSON.parse(await fs.readFile(path.join(sourceDir, chunk.path), 'utf8'))
    sourceFeatures.push(...collection.features)
  }
  const sourceVertices = countVertices(sourceFeatures)

  const tempDir = mkdtempSync(path.join(tmpdir(), 'canada-csd-simplified-'))
  const tempInputPath = path.join(tempDir, 'canada-csd-full.geojson')
  const tempOutputPath = path.join(tempDir, 'canada-csd-simplified.geojson')

  try {
    await fs.writeFile(tempInputPath, JSON.stringify({ type: 'FeatureCollection', features: sourceFeatures }))
    execFileSync('npx', [
      '--yes',
      `mapshaper@${MAPSHAPER_VERSION}`,
      tempInputPath,
      '-clean',
      '-filter-islands',
      `min-area=${MIN_ISLAND_AREA}`,
      '-simplify',
      SIMPLIFY_KEEP,
      'keep-shapes',
      '-clean',
      '-o',
      'force',
      'format=geojson',
      `precision=${COORDINATE_PRECISION}`,
      tempOutputPath,
    ], {
      stdio: 'inherit',
      maxBuffer: 1024 * 1024 * 64,
    })

    const simplified = JSON.parse(await fs.readFile(tempOutputPath, 'utf8'))
    if (simplified.type !== 'FeatureCollection' || !Array.isArray(simplified.features)) {
      throw new Error('Mapshaper output was not a GeoJSON FeatureCollection')
    }

    const simplifiedFeatures = simplified.features
      .filter((feature) => feature.geometry && (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon'))
      .filter((feature) => feature.properties?.CSDUID)

    const simplifiedUids = new Set(simplifiedFeatures.map((feature) => String(feature.properties.CSDUID)))
    const recoveredFeatures = sourceFeatures
      .filter((feature) => !simplifiedUids.has(String(feature.properties.CSDUID)))
      .map((feature) => fallbackFeature(feature))
      .filter((feature) => feature !== null)

    const features = [...simplifiedFeatures, ...recoveredFeatures]
      .map((feature) => {
        const properties = {}
        for (const key of KEEP_PROPERTIES) {
          if (feature.properties?.[key] != null) properties[key] = feature.properties[key]
        }
        return { type: 'Feature', geometry: feature.geometry, properties }
      })
      .sort((a, b) => String(a.properties.CSDUID).localeCompare(String(b.properties.CSDUID)))

    const text = JSON.stringify({ type: 'FeatureCollection', features })
    await fs.writeFile(outputPath, text)

    const outputVertices = countVertices(features)
    const rawMiB = (Buffer.byteLength(text) / 1024 / 1024).toFixed(1)
    const gzipMiB = (gzipSync(text, { level: 9 }).byteLength / 1024 / 1024).toFixed(1)
    console.log(
      `[canada-csd-simplified] mapshaper@${MAPSHAPER_VERSION}: ` +
      `${features.length.toLocaleString()} / ${sourceFeatures.length.toLocaleString()} features ` +
      `(${recoveredFeatures.length.toLocaleString()} recovered via fallback), ` +
      `${sourceVertices.toLocaleString()} -> ${outputVertices.toLocaleString()} vertices, ` +
      `${rawMiB} MiB raw (${gzipMiB} MiB gzip) -> ${path.relative(process.cwd(), outputPath)}`,
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
