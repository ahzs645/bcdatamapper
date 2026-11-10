// Builds the two vector context layers the EchoScreen climate-health project
// shows beside the climate surfaces: the Fraser and Nechako named watersheds,
// and Northern Health's hospitals.
//
// Both are exact selections from snapshots this repository already holds, so
// they are committed here and PGMaps copies them like any other output.
//
// Usage: node datascrapers/climate/echoscreen/build-project-layers.mjs [--watersheds-only]
//
// --watersheds-only skips the hospitals, which need the nested
// data-sources/healthdata submodule.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(scriptPath), '..', '..', '..')
const outputDir = path.join(path.dirname(scriptPath), 'project-layers')

export const WATERSHED_SOURCE_DIRECTORY = path.join(repoRoot, 'datascrapers/bc/boundaries/output/BCFWA')
export const HOSPITAL_SOURCE_PATH = path.join(
  repoRoot,
  'data-sources/healthdata/health_place_registry/health_place_registry.geojson',
)
export const WATERSHED_OUTPUT_PATH = path.join(outputDir, 'echoscreen_fraser_nechako.geojson')
export const HOSPITAL_OUTPUT_PATH = path.join(outputDir, 'echoscreen-northern-health-hospitals.geojson')

export const WATERSHED_SELECTIONS = [
  { namedWatershedId: 11541, name: 'Fraser River', streamOrder: 10 },
  { namedWatershedId: 8886, name: 'Nechako River', streamOrder: 8 },
]
export const EXPECTED_HOSPITALS = 18

function readSelectedWatershed(selection, sourceDirectory) {
  const filename = `named_watersheds_stream_order_${selection.streamOrder}_50m.geojson.gz`
  const collection = JSON.parse(gunzipSync(readFileSync(path.join(sourceDirectory, filename))).toString('utf8'))
  const feature = collection.features.find(
    (candidate) => Number(candidate.properties?.namedWatershedId) === selection.namedWatershedId,
  )

  if (!feature) {
    throw new Error(`Missing named watershed ${selection.namedWatershedId} in ${filename}`)
  }
  if (
    feature.properties?.name !== selection.name ||
    Number(feature.properties?.streamOrder) !== selection.streamOrder
  ) {
    throw new Error(
      `Named watershed ${selection.namedWatershedId} no longer matches ${selection.name}, stream order ${selection.streamOrder}`,
    )
  }

  return feature
}

/** The Fraser and Nechako watersheds, picked by id from the stream-order shards. */
export function buildWatershedCollection(sourceDirectory = WATERSHED_SOURCE_DIRECTORY) {
  return {
    type: 'FeatureCollection',
    name: 'echoscreen_fraser_nechako',
    metadata: {
      source: 'Government of British Columbia Freshwater Atlas',
      sourceLayer: 'FWA_NAMED_WATERSHEDS_POLY',
      derivation: 'Exact feature selection from 50 metre topology-preserved stream-order shards',
      namedWatershedIds: WATERSHED_SELECTIONS.map((selection) => selection.namedWatershedId),
    },
    features: WATERSHED_SELECTIONS.map((selection) => readSelectedWatershed(selection, sourceDirectory)),
  }
}

function hospitalCoordinateKey(feature) {
  return feature.geometry.coordinates.map((coordinate) => Number(coordinate).toFixed(6)).join(',')
}

function hospitalId(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Northern Health hospitals from a health place registry collection, one per
 * point. Where two records share a point, a verified one wins.
 */
export function buildHospitalCollection(registry) {
  const hospitalByCoordinate = new Map()

  for (const feature of registry.features) {
    const properties = feature.properties ?? {}
    if (feature.geometry?.type !== 'Point') continue
    if (properties.place_type !== 'hospital') continue
    if (!String(properties.source_url ?? '').includes('northernhealth.ca')) continue

    const key = hospitalCoordinateKey(feature)
    const existing = hospitalByCoordinate.get(key)
    const existingVerified = existing?.properties?.verification_status === 'verified'
    const candidateVerified = properties.verification_status === 'verified'
    if (!existing || (candidateVerified && !existingVerified)) hospitalByCoordinate.set(key, feature)
  }

  const features = [...hospitalByCoordinate.values()]
    .map((feature) => {
      const properties = feature.properties
      return {
        type: 'Feature',
        properties: {
          id: hospitalId(properties.canonical_name),
          name: properties.canonical_name,
          locality: properties.locality,
          address: properties.address,
          healthAuthority: properties.health_authority ?? 'Northern Health',
          sourceLabel: properties.source_label,
          sourceUrl: properties.source_url,
          verificationStatus: properties.verification_status,
        },
        geometry: feature.geometry,
      }
    })
    .sort((left, right) => left.properties.name.localeCompare(right.properties.name))

  return {
    type: 'FeatureCollection',
    name: 'echoscreen_northern_health_hospitals',
    metadata: {
      source: 'BC Data Mapper health place registry',
      derivation: 'Northern Health hospital pages, deduplicated by point coordinate',
      features: features.length,
    },
    features,
  }
}

function writeCollection(outputPath, collection) {
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(collection)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const watersheds = buildWatershedCollection()
  writeCollection(WATERSHED_OUTPUT_PATH, watersheds)
  const watershedSummary = watersheds.features
    .map(
      (feature) =>
        `${feature.properties.name} ${feature.properties.namedWatershedId} (${feature.properties.areaKm2.toLocaleString()} km²)`,
    )
    .join(', ')
  console.log(
    `[echoscreen-layers] wrote ${path.relative(process.cwd(), WATERSHED_OUTPUT_PATH)}: ${watershedSummary}`,
  )

  if (!process.argv.includes('--watersheds-only')) {
    const hospitals = buildHospitalCollection(JSON.parse(readFileSync(HOSPITAL_SOURCE_PATH, 'utf8')))
    if (hospitals.features.length !== EXPECTED_HOSPITALS) {
      throw new Error(
        `Expected ${EXPECTED_HOSPITALS} unique Northern Health hospitals, found ${hospitals.features.length}`,
      )
    }
    writeCollection(HOSPITAL_OUTPUT_PATH, hospitals)
    console.log(
      `[echoscreen-layers] wrote ${path.relative(process.cwd(), HOSPITAL_OUTPUT_PATH)}: ${hospitals.features.length} hospital points`,
    )
  }
}
