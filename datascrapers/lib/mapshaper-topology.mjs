import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const MAPSHAPER_VERSION = '0.6.113'

function assertFeatureCollection(collection) {
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('Expected a GeoJSON FeatureCollection')
  }
}

function projectionArgs(crs, sourceCrs) {
  if (!crs || crs === sourceCrs) return []
  return ['-proj', crs, `init=${sourceCrs}`]
}

/**
 * Simplify one complete polygon coverage as shared topology.
 *
 * All adjacent features must be supplied in the same collection. Mapshaper
 * builds shared arcs before applying Ramer-Douglas-Peucker, so both sides of a
 * common border receive the same simplified coordinates.
 */
export function simplifySharedPolygonTopology(collection, {
  toleranceMetres,
  sourceCrs = 'EPSG:4326',
  workingCrs = 'EPSG:3005',
  outputCrs = 'EPSG:4326',
  coordinatePrecision = 6,
  tempPrefix = 'mapshaper-topology-',
  cleanOptions = [],
  snapIntervalMetres = 0,
} = {}) {
  assertFeatureCollection(collection)
  if (!Number.isFinite(toleranceMetres) || toleranceMetres <= 0) {
    throw new Error('toleranceMetres must be a positive number')
  }
  if (!Number.isInteger(coordinatePrecision) || coordinatePrecision < 0 || coordinatePrecision > 12) {
    throw new Error('coordinatePrecision must be an integer from 0 to 12')
  }

  const tempDir = mkdtempSync(join(tmpdir(), tempPrefix))
  const inputPath = join(tempDir, 'input.geojson')
  const outputPath = join(tempDir, 'output.geojson')

  try {
    writeFileSync(inputPath, JSON.stringify(collection))
    const args = [
      '--yes',
      '--package',
      `mapshaper@${MAPSHAPER_VERSION}`,
      '--',
      'mapshaper',
      inputPath,
      '-clean',
      ...cleanOptions,
      ...projectionArgs(workingCrs, sourceCrs),
      ...(snapIntervalMetres > 0 ? ['-clean', `snap-interval=${snapIntervalMetres}`] : []),
      '-simplify',
      'dp',
      `interval=${toleranceMetres}`,
      'keep-shapes',
      '-clean',
      ...cleanOptions,
      ...projectionArgs(outputCrs, workingCrs),
      '-clean',
      ...cleanOptions,
      '-o',
      'force',
      'format=geojson',
      `precision=${10 ** -coordinatePrecision}`,
      outputPath,
    ]

    execFileSync('npx', args, {
      stdio: 'inherit',
      maxBuffer: 1024 * 1024 * 128,
    })

    const output = JSON.parse(readFileSync(outputPath, 'utf8'))
    assertFeatureCollection(output)
    if (output.features.length !== collection.features.length) {
      throw new Error(
        `Mapshaper changed the feature count from ${collection.features.length} to ${output.features.length}`,
      )
    }
    const emptyGeometryCount = output.features.filter((feature) => !feature.geometry).length
    if (emptyGeometryCount > 0) {
      throw new Error(`Mapshaper produced ${emptyGeometryCount} features without geometry`)
    }
    return output
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}
