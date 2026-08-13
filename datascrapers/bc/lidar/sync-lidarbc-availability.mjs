import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import {
  simplifyPolygonTopology,
  TOPOLOGY_PROFILES,
} from '../../lib/mapshaper-topology.mjs'

const PORTAL_URL = 'https://lidar.gov.bc.ca/'
const APP_ID = '33ecd51f1e504929a4ff8378719816ce'
const WEB_MAP_ID = 'c2967cee749b4bdbac5e7c62935ca167'
const SERVICE_URL = 'https://services6.arcgis.com/ubm4tcTYICKBpist/arcgis/rest/services/LiDAR_BC_S3_Public/FeatureServer'
const OUTPUT_PATH = 'datascrapers/bc/boundaries/output/BCLidar/lidarbc-data-availability.geojson'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const VENDOR_ROOT = join(SCRIPT_DIR, '..', '..', '..')

const LAYERS = [
  { id: 0, key: 'availabilityFootprints' },
  { id: 1, key: 'dsm2500Tiles' },
  { id: 2, key: 'dsm10000Tiles' },
  { id: 3, key: 'dsm20000Tiles' },
  { id: 4, key: 'pointCloudTiles' },
  { id: 5, key: 'dem2500Tiles' },
  { id: 6, key: 'dem20000Tiles' },
]

function era(year) {
  if (year <= 2018) return '2011–2018'
  if (year <= 2022) return '2019–2022'
  if (year === 2023) return '2023 acquisition'
  if (year === 2024) return '2024 acquisition'
  return '2025–2026'
}

async function fetchJson(url, label) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to fetch ${label}: ${response.status}`)
  const payload = await response.json()
  if (payload.error) throw new Error(`${label} returned ArcGIS error: ${JSON.stringify(payload.error)}`)
  return payload
}

const layerSummaries = {}
for (const layer of LAYERS) {
  const [metadata, count] = await Promise.all([
    fetchJson(`${SERVICE_URL}/${layer.id}?f=json`, `layer ${layer.id} metadata`),
    fetchJson(
      `${SERVICE_URL}/${layer.id}/query?where=1%3D1&returnCountOnly=true&f=json`,
      `layer ${layer.id} count`,
    ),
  ])
  layerSummaries[layer.key] = {
    layerId: layer.id,
    name: metadata.name,
    count: count.count,
    lastEdit: metadata.editingInfo?.lastEditDate
      ? new Date(metadata.editingInfo.lastEditDate).toISOString()
      : null,
  }
}

const query = new URLSearchParams({
  where: '1=1',
  outFields: 'OBJECTID,YEAR_,Shape__Area',
  returnGeometry: 'true',
  outSR: '4326',
  orderByFields: 'YEAR_',
  f: 'geojson',
})
const sourceResponse = await fetch(`${SERVICE_URL}/0/query?${query}`)
if (!sourceResponse.ok) throw new Error(`Failed to fetch LiDAR availability footprints: ${sourceResponse.status}`)
const sourceText = await sourceResponse.text()
const source = JSON.parse(sourceText)
if (source.type !== 'FeatureCollection' || source.features.length !== 13) {
  throw new Error(`Expected 13 annual LiDAR availability features, received ${source.features?.length ?? 'invalid data'}`)
}

const expectedYears = [2011, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]
const features = source.features.map((feature) => {
  const year = Number(feature.properties.YEAR_)
  const sourceAreaKm2 = Math.round((Number(feature.properties.Shape__Area) / 1_000_000) * 10) / 10
  return {
    type: 'Feature',
    id: String(year),
    geometry: feature.geometry,
    properties: {
      id: String(year),
      year,
      era: era(year),
      title: `${year} LiDAR availability`,
      source_area_km2: sourceAreaKm2,
      display: `${year} · ${sourceAreaKm2.toLocaleString('en-CA')} km² source footprint`,
      details: [
        `Data-availability footprint published for ${year}.`,
        `Source footprint area: ${sourceAreaKm2.toLocaleString('en-CA')} km².`,
        'This is a simplified overview. Use the LidarBC portal to select and download individual product tiles.',
      ].join('\n'),
    },
  }
})
const actualYears = features.map((feature) => feature.properties.year)
if (JSON.stringify(actualYears) !== JSON.stringify(expectedYears)) {
  throw new Error(`Unexpected LiDAR availability years: ${actualYears.join(', ')}`)
}

const simplified = simplifyPolygonTopology({ type: 'FeatureCollection', features }, {
  toleranceMetres: 250,
  topologyProfile: TOPOLOGY_PROFILES.OVERLAP,
  sourceCrs: 'EPSG:4326',
  workingCrs: 'EPSG:3005',
  outputCrs: 'EPSG:4326',
  coordinatePrecision: 6,
  tempPrefix: 'lidarbc-availability-',
})

const output = {
  type: 'FeatureCollection',
  name: 'lidarbc_data_availability',
  metadata: {
    title: 'LidarBC Data Availability',
    portal: PORTAL_URL,
    arcgisAppId: APP_ID,
    arcgisWebMapId: WEB_MAP_ID,
    sourceService: `${SERVICE_URL}/0`,
    sourceBytes: Buffer.byteLength(sourceText),
    featureCount: simplified.features.length,
    yearRange: '2011, 2015–2026',
    simplificationToleranceMetres: 250,
    topologyProfile: TOPOLOGY_PROFILES.OVERLAP,
    note: 'Cartographic overview only; tile-level downloads remain in LidarBC.',
    layers: layerSummaries,
  },
  features: simplified.features.sort((left, right) => left.properties.year - right.properties.year),
}

const payload = `${JSON.stringify(output)}\n`
const outputPath = join(VENDOR_ROOT, OUTPUT_PATH)
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, payload)
console.log(JSON.stringify({
  output: OUTPUT_PATH,
  features: output.features.length,
  sourceBytes: Buffer.byteLength(sourceText),
  bytes: Buffer.byteLength(payload),
  gzipBytes: gzipSync(payload).length,
  layerCounts: Object.fromEntries(Object.entries(layerSummaries).map(([key, value]) => [key, value.count])),
}))
