import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAPSHAPER_VERSION,
  simplifySharedPolygonTopology,
} from '../../lib/mapshaper-topology.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = join(SCRIPT_DIR, 'output', 'BCMoH')
const SIMPLIFIED_DIR = join(OUTPUT_DIR, 'simplified')
const SOURCE_CRS = 'EPSG:4326'
const WORKING_CRS = 'EPSG:3005'
const OUTPUT_CRS = 'EPSG:4326'
const COORDINATE_PRECISION = 6

const LAYERS = [
  { file: 'health_authorities.json', toleranceMetres: 100 },
  { file: 'health_service_delivery_areas.json', toleranceMetres: 75 },
  { file: 'local_health_areas.json', toleranceMetres: 50 },
  { file: 'community_health_service_areas.json', toleranceMetres: 25 },
]

mkdirSync(SIMPLIFIED_DIR, { recursive: true })

for (const layer of LAYERS) {
  const sourcePath = join(OUTPUT_DIR, layer.file)
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
  const simplified = simplifySharedPolygonTopology(source, {
    toleranceMetres: layer.toleranceMetres,
    sourceCrs: SOURCE_CRS,
    workingCrs: WORKING_CRS,
    outputCrs: OUTPUT_CRS,
    coordinatePrecision: COORDINATE_PRECISION,
    tempPrefix: `bc-health-${layer.file.replace(/\W+/gu, '-')}-`,
  })
  const output = {
    type: 'FeatureCollection',
    metadata: {
      sourceSnapshot: layer.file,
      sourceCrs: SOURCE_CRS,
      workingCrs: WORKING_CRS,
      outputCrs: OUTPUT_CRS,
      simplification: 'Mapshaper shared-topology Ramer-Douglas-Peucker',
      simplificationToleranceMetres: layer.toleranceMetres,
      topologyPreserving: true,
      mapshaperVersion: MAPSHAPER_VERSION,
      coordinatePrecision: COORDINATE_PRECISION,
    },
    features: simplified.features,
  }
  const outputPath = join(SIMPLIFIED_DIR, layer.file)
  writeFileSync(outputPath, `${JSON.stringify(output)}\n`)
  console.log(`${layer.file}: wrote ${output.features.length} topology-safe features`)
}
