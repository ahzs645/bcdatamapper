import { gzipSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const OUTPUT_DIR = 'public/data/ev-charging'
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')
const STATIONS_GEOJSON_PATH = path.join(OUTPUT_DIR, 'stations.geojson')
const API_BASE = 'https://developer.nlr.gov/api/alt-fuel-stations/v1'
const API_KEY = process.env.NLR_API_KEY || 'DEMO_KEY'

const stationCsvUrl = `${API_BASE}.csv?api_key=${API_KEY}&fuel_type=ELEC&country=CA&status=E`
const stationJsonUrl = `${API_BASE}.json?api_key=${API_KEY}&fuel_type=ELEC&country=CA&status=E&limit=all`
const unitCsvUrl = `${API_BASE}/ev-charging-units.csv?api_key=${API_KEY}&country=CA&status=E`

async function fetchBytes(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'PGMaps bcdatamapper EV charging scraper',
      accept: '*/*',
    },
  })
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

function gzipSize(buffer) {
  return gzipSync(buffer, { level: 9 }).byteLength
}

function compactStationFeature(station) {
  const longitude = Number(station.longitude)
  const latitude = Number(station.latitude)
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null

  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [longitude, latitude],
    },
    properties: {
      id: station.id,
      name: station.station_name,
      city: station.city,
      province: station.state,
      network: station.ev_network,
      status: station.status_code,
      access: station.access_code,
      connectors: station.ev_connector_types,
      level2: station.ev_level2_evse_num,
      dcFast: station.ev_dc_fast_num,
      j1772: station.ev_j1772_connector_count,
      ccs: station.ev_ccs_connector_count,
      chademo: station.ev_chademo_connector_count,
      j3400: station.ev_j3400_connector_count,
      updatedAt: station.updated_at,
    },
  }
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true })

  const [stationCsv, unitCsv, stationJsonBytes] = await Promise.all([
    fetchBytes(stationCsvUrl),
    fetchBytes(unitCsvUrl),
    fetchBytes(stationJsonUrl),
  ])

  const stationJson = JSON.parse(stationJsonBytes.toString('utf8'))
  const features = (stationJson.fuel_stations ?? [])
    .map(compactStationFeature)
    .filter(Boolean)

  const stationsGeojson = {
    type: 'FeatureCollection',
    features,
  }
  const stationsGeojsonBytes = Buffer.from(`${JSON.stringify(stationsGeojson)}\n`, 'utf8')
  await writeFile(STATIONS_GEOJSON_PATH, stationsGeojsonBytes)

  const manifest = {
    generatedAt: new Date().toISOString(),
    title: 'Canada EV charging stations',
    description:
      'Station-level and charging-unit exports for open public electric vehicle charging locations in Canada, plus a compact GeoJSON point layer for PGMaps.',
    source: 'NLR / Alternative Fuel Stations API',
    coverage: 'Canada',
    license: 'NLR Alternative Fuel Stations API terms',
    apiDocumentationUrl: 'https://developer.nlr.gov/docs/transportation/alt-fuel-stations-v1/',
    recommendedUse:
      'Use the compact GeoJSON for map display. Use the station-level CSV for site attributes and the charging-unit CSV when one row per EV charging unit/port is needed.',
    counts: {
      stations: stationJson.total_results ?? features.length,
      stationFeatures: features.length,
      chargingUnits: Math.max(0, unitCsv.toString('utf8').split(/\r?\n/).filter(Boolean).length - 1),
    },
    resources: [
      {
        id: 'stations-csv',
        title: 'Station-level Canada EV CSV',
        geometry: 'point',
        format: 'CSV',
        url: stationCsvUrl.replace(API_KEY, 'DEMO_KEY'),
        rawBytes: stationCsv.byteLength,
        gzipBytes: gzipSize(stationCsv),
      },
      {
        id: 'charging-units-csv',
        title: 'Charging-unit Canada EV CSV',
        geometry: 'point',
        format: 'CSV',
        url: unitCsvUrl.replace(API_KEY, 'DEMO_KEY'),
        rawBytes: unitCsv.byteLength,
        gzipBytes: gzipSize(unitCsv),
      },
      {
        id: 'stations-geojson',
        title: 'Compact station point GeoJSON',
        geometry: 'point',
        format: 'GeoJSON',
        url: '/data/ev-charging/stations.geojson',
        rawBytes: stationsGeojsonBytes.byteLength,
        gzipBytes: gzipSize(stationsGeojsonBytes),
      },
    ],
  }

  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`ev-charging: wrote ${features.length} stations to ${STATIONS_GEOJSON_PATH}`)
  console.log(`ev-charging: wrote manifest to ${MANIFEST_PATH}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
