// Dissolves B.C.'s census subdivisions into two North/South polygons.
//
// The per-CSD province file stays the source for anything that picks out
// single subdivisions. This file is for maps that show only the two-way split,
// where the interior CSD seams and a 24 MB payload are noise.
//
// Usage: node datascrapers/census/build-bc-north-south-dissolved.mjs [--if-missing]
//
// build-canada-csd.mjs clears output/canada-csd before it writes, so it calls
// buildBcNorthSouthDissolved() itself after a full rebuild.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { MAPSHAPER_VERSION } from '../lib/mapshaper-topology.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const outputDir = path.join(path.dirname(scriptPath), 'output', 'canada-csd')

export const BC_CSD_SOURCE_PATH = path.join(outputDir, 'provinces', '59.geojson.gz')
export const BC_NORTH_SOUTH_DISSOLVED_PATH = path.join(outputDir, 'bc-north-south-dissolved.geojson')

/** Writes the dissolved file and returns its two features' summary. */
export function buildBcNorthSouthDissolved({
  sourcePath = BC_CSD_SOURCE_PATH,
  outputPath = BC_NORTH_SOUTH_DISSOLVED_PATH,
} = {}) {
  const workDir = mkdtempSync(path.join(tmpdir(), 'census-dissolve-'))
  try {
    const inputPath = path.join(workDir, 'csd.geojson')
    writeFileSync(inputPath, gunzipSync(readFileSync(sourcePath)))

    execFileSync(
      'npx',
      [
        '--yes',
        `mapshaper@${MAPSHAPER_VERSION}`,
        inputPath,
        'snap',
        '-filter',
        'north_south == "North" || north_south == "South"',
        '-dissolve2',
        'north_south',
        // Shown at province zoom: drop coastline detail and islands under
        // 2 km², which read as noise there and are 90% of the file.
        '-simplify',
        'interval=150',
        'keep-shapes',
        '-filter-islands',
        'min-area=2km2',
        '-each',
        'label = "Statistical " + north_south',
        '-filter-fields',
        'north_south,label',
        '-clean',
        '-o',
        'precision=0.00001',
        outputPath,
      ],
      { stdio: 'inherit' },
    )

    const result = JSON.parse(readFileSync(outputPath, 'utf8'))
    const regions = result.features.map((feature) => feature.properties.north_south).sort()
    if (regions.join(',') !== 'North,South') {
      throw new Error(`Expected one North and one South feature, found ${regions.join(', ') || 'none'}`)
    }
    return result.features.map((feature) => ({
      region: feature.properties.north_south,
      polygons: feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates.length : 1,
    }))
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const relativeOutput = path.relative(process.cwd(), BC_NORTH_SOUTH_DISSOLVED_PATH)
  if (process.argv.includes('--if-missing') && existsSync(BC_NORTH_SOUTH_DISSOLVED_PATH)) {
    console.log(`[census-north-south-dissolved] up to date: ${relativeOutput}`)
  } else {
    const summary = buildBcNorthSouthDissolved()
      .map(({ region, polygons }) => `${region}: ${polygons} polygons`)
      .join(', ')
    const sizeMb = (readFileSync(BC_NORTH_SOUTH_DISSOLVED_PATH).byteLength / 1024 / 1024).toFixed(1)
    console.log(`[census-north-south-dissolved] wrote ${relativeOutput} (${sizeMb} MB): ${summary}`)
  }
}
