import { execFileSync } from 'node:child_process'
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const MAPSHAPER_VERSION = '0.6.113'
export const TOPOLOGY_PROFILES = Object.freeze({
  PARTITION: 'partition',
  OVERLAP: 'overlap',
})
const PIPELINE_INDEX_PROPERTY = '__pgmapsTopologyPipelineIndex'

function assertFeatureCollection(collection) {
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error('Expected a GeoJSON FeatureCollection')
  }
}

function hasUsablePolygonGeometry(geometry) {
  if (geometry?.type === 'Polygon') {
    return geometry.coordinates?.some((ring) => Array.isArray(ring) && ring.length >= 4) ?? false
  }
  if (geometry?.type === 'MultiPolygon') {
    return geometry.coordinates?.some((polygon) => (
      polygon.some((ring) => Array.isArray(ring) && ring.length >= 4)
    )) ?? false
  }
  return false
}

function projectionArgs(crs, sourceCrs) {
  if (!crs || crs === sourceCrs) return []
  return ['-proj', crs, `init=${sourceCrs}`]
}

function roundCoordinates(value, decimalPlaces) {
  if (!Array.isArray(value)) return value
  if (typeof value[0] === 'number') {
    return value.map((coordinate) => Number(coordinate.toFixed(decimalPlaces)))
  }
  return value.map((entry) => roundCoordinates(entry, decimalPlaces))
}

function writeFeatureCollectionSync(path, collection) {
  const descriptor = openSync(path, 'w')
  try {
    writeSync(descriptor, '{"type":"FeatureCollection","features":[')
    collection.features.forEach((feature, index) => {
      if (index > 0) writeSync(descriptor, ',')
      writeSync(descriptor, JSON.stringify(feature))
    })
    writeSync(descriptor, ']}')
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Simplify one complete polygon collection as shared topology.
 *
 * All adjacent features must be supplied in the same collection. Mapshaper
 * builds shared arcs before applying Ramer-Douglas-Peucker, so both sides of a
 * common border receive the same simplified coordinates. Partition mode also
 * repairs gaps, overlaps and sliver rings; overlap mode deliberately skips
 * cleaning so thematic/tenure overlaps remain intact.
 */
export function simplifyPolygonTopology(collection, {
  toleranceMetres,
  sourceCrs = 'EPSG:4326',
  workingCrs = 'EPSG:3005',
  outputCrs = 'EPSG:4326',
  coordinatePrecision = 6,
  topologyProfile = TOPOLOGY_PROFILES.PARTITION,
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
  if (!Object.values(TOPOLOGY_PROFILES).includes(topologyProfile)) {
    throw new Error(`topologyProfile must be one of: ${Object.values(TOPOLOGY_PROFILES).join(', ')}`)
  }
  const unsupportedGeometryCount = collection.features.filter((feature) => (
    feature.geometry && feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon'
  )).length
  if (unsupportedGeometryCount > 0) {
    throw new Error(`Expected polygon geometry; found ${unsupportedGeometryCount} unsupported features`)
  }
  const sourceFeatures = collection.features.filter((feature) => hasUsablePolygonGeometry(feature.geometry))
  const droppedInvalidGeometryFeatureCount = collection.features.length - sourceFeatures.length

  const cleanArgs = topologyProfile === TOPOLOGY_PROFILES.PARTITION
    ? ['-clean', ...cleanOptions]
    : []

  const tempDir = mkdtempSync(join(tmpdir(), tempPrefix))
  const inputPath = join(tempDir, 'input.geojson')
  const outputPath = join(tempDir, 'output.geojson')
  const indexedCollection = {
    ...collection,
    features: sourceFeatures.map((feature, index) => {
      if (Object.hasOwn(feature.properties ?? {}, PIPELINE_INDEX_PROPERTY)) {
        throw new Error(`Input property ${PIPELINE_INDEX_PROPERTY} is reserved by the topology pipeline`)
      }
      return {
        ...feature,
        properties: {
          ...(feature.properties ?? {}),
          [PIPELINE_INDEX_PROPERTY]: index,
        },
      }
    }),
  }

  try {
    writeFeatureCollectionSync(inputPath, indexedCollection)
    const args = [
      '--yes',
      '--package',
      `mapshaper@${MAPSHAPER_VERSION}`,
      '--',
      'mapshaper',
      inputPath,
      ...cleanArgs,
      ...projectionArgs(workingCrs, sourceCrs),
      ...(topologyProfile === TOPOLOGY_PROFILES.PARTITION && snapIntervalMetres > 0
        ? ['-clean', `snap-interval=${snapIntervalMetres}`]
        : []),
      '-simplify',
      'dp',
      `interval=${toleranceMetres}`,
      'keep-shapes',
      ...(topologyProfile === TOPOLOGY_PROFILES.OVERLAP ? ['no-repair'] : []),
      ...cleanArgs,
      ...projectionArgs(outputCrs, workingCrs),
      ...cleanArgs,
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
    if (
      topologyProfile === TOPOLOGY_PROFILES.PARTITION &&
      output.features.length !== indexedCollection.features.length
    ) {
      throw new Error(
        `Mapshaper changed the feature count from ${indexedCollection.features.length} to ${output.features.length}`,
      )
    }

    const outputByIndex = new Map(output.features.map((feature) => [
      Number(feature.properties?.[PIPELINE_INDEX_PROPERTY]),
      feature,
    ]))
    const missingIndexes = indexedCollection.features
      .map((_, index) => index)
      .filter((index) => !hasUsablePolygonGeometry(outputByIndex.get(index)?.geometry))

    if (missingIndexes.length > 0 && topologyProfile === TOPOLOGY_PROFILES.PARTITION) {
      throw new Error(`Mapshaper produced ${missingIndexes.length} features without geometry`)
    }
    if (missingIndexes.length > 0) {
      const fallbackInputPath = join(tempDir, 'fallback-input.geojson')
      const fallbackOutputPath = join(tempDir, 'fallback-output.geojson')
      writeFeatureCollectionSync(fallbackInputPath, {
        type: 'FeatureCollection',
        features: missingIndexes.map((index) => indexedCollection.features[index]),
      })
      execFileSync('npx', [
        '--yes',
        '--package',
        `mapshaper@${MAPSHAPER_VERSION}`,
        '--',
        'mapshaper',
        fallbackInputPath,
        ...projectionArgs(outputCrs, sourceCrs),
        '-o',
        'force',
        'format=geojson',
        `precision=${10 ** -coordinatePrecision}`,
        fallbackOutputPath,
      ], {
        stdio: 'inherit',
        maxBuffer: 1024 * 1024 * 128,
      })
      const fallback = JSON.parse(readFileSync(fallbackOutputPath, 'utf8'))
      assertFeatureCollection(fallback)
      for (const feature of fallback.features) {
        const index = Number(feature.properties?.[PIPELINE_INDEX_PROPERTY])
        if (hasUsablePolygonGeometry(feature.geometry)) outputByIndex.set(index, feature)
      }
      if (sourceCrs === outputCrs) {
        for (const index of missingIndexes) {
          if (hasUsablePolygonGeometry(outputByIndex.get(index)?.geometry)) continue
          const sourceFeature = indexedCollection.features[index]
          outputByIndex.set(index, {
            ...sourceFeature,
            geometry: {
              ...sourceFeature.geometry,
              coordinates: roundCoordinates(sourceFeature.geometry.coordinates, coordinatePrecision),
            },
          })
        }
      }
    }

    output.features = indexedCollection.features.map((_, index) => {
      const feature = outputByIndex.get(index)
      if (!hasUsablePolygonGeometry(feature?.geometry)) {
        throw new Error(`Mapshaper could not preserve geometry for source feature ${index}`)
      }
      const properties = { ...(feature.properties ?? {}) }
      delete properties[PIPELINE_INDEX_PROPERTY]
      return { ...feature, properties }
    })
    if (collection.name != null) output.name = collection.name
    output.metadata = {
      ...(collection.metadata ?? {}),
      sourceCrs,
      workingCrs,
      outputCrs,
      simplification: 'Mapshaper shared-topology Ramer-Douglas-Peucker',
      simplificationToleranceMetres: toleranceMetres,
      topologyProfile,
      topologyPreserving: true,
      cleaningApplied: topologyProfile === TOPOLOGY_PROFILES.PARTITION,
      intentionalOverlapPreserved: topologyProfile === TOPOLOGY_PROFILES.OVERLAP,
      unsimplifiedFallbackFeatureCount: missingIndexes.length,
      sourceFeatureCount: collection.features.length,
      droppedInvalidGeometryFeatureCount,
      outputFeatureCount: output.features.length,
      mapshaperVersion: MAPSHAPER_VERSION,
      coordinatePrecision,
    }
    return output
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

/** @deprecated Use simplifyPolygonTopology() with an explicit profile. */
export function simplifySharedPolygonTopology(collection, options = {}) {
  return simplifyPolygonTopology(collection, {
    ...options,
    topologyProfile: TOPOLOGY_PROFILES.PARTITION,
  })
}
