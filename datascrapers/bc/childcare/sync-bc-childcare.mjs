import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CHILDCARE_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(CHILDCARE_DIR, 'output')
const OUTPUT_GEOJSON = path.join(OUTPUT_DIR, 'bc_childcare_locations.geojson')
const OUTPUT_MANIFEST = path.join(OUTPUT_DIR, 'manifest.json')

const LAYER_URL =
  'https://delivery.maps.gov.bc.ca/arcgis/rest/services/mpcm/bcgwpub/MapServer/700'
const METADATA_URL =
  'https://catalogue.data.gov.bc.ca/dataset/4cc207cc-ff03-44f8-8c5f-415af5224646'
const MAP_URL = 'https://maps.gov.bc.ca/ess/hm/ccf/'
const CSV_URL =
  'https://catalogue.data.gov.bc.ca/dataset/4cc207cc-ff03-44f8-8c5f-415af5224646/resource/9a9f14e1-03ea-4a11-936a-6e77b15eeb39/download/childcare_locations.csv'
const PAGE_SIZE = 1000

function layerQueryUrl(offset) {
  const params = new URLSearchParams({
    where: "UPPER(LOCALITY) = 'PRINCE GEORGE'",
    outFields: '*',
    outSR: '4326',
    f: 'geojson',
    returnGeometry: 'true',
    resultRecordCount: String(PAGE_SIZE),
    resultOffset: String(offset),
  })
  return `${LAYER_URL}/query?${params.toString()}`
}

async function fetchLayer() {
  const features = []
  let offset = 0

  while (true) {
    const response = await fetch(layerQueryUrl(offset), {
      headers: { 'user-agent': 'PGMaps bcdatamapper childcare scraper' },
    })
    if (!response.ok) throw new Error(`Failed to fetch child care layer: ${response.status}`)
    const geojson = await response.json()
    const pageFeatures = geojson.features ?? []
    features.push(...pageFeatures)
    if (!geojson.exceededTransferLimit || pageFeatures.length < PAGE_SIZE) break
    offset += pageFeatures.length
  }

  return features
}

function toUtm10Nad83(lon, lat) {
  const a = 6378137
  const f = 1 / 298.257222101
  const e2 = f * (2 - f)
  const ep2 = e2 / (1 - e2)
  const k0 = 0.9996
  const lon0 = (-123 * Math.PI) / 180
  const latRad = (lat * Math.PI) / 180
  const lonRad = (lon * Math.PI) / 180
  const sinLat = Math.sin(latRad)
  const cosLat = Math.cos(latRad)
  const tanLat = Math.tan(latRad)
  const n = a / Math.sqrt(1 - e2 * sinLat * sinLat)
  const t = tanLat * tanLat
  const c = ep2 * cosLat * cosLat
  const aa = cosLat * (lonRad - lon0)
  const m =
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * latRad -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * latRad) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * latRad) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * latRad))

  const easting =
    k0 *
      n *
      (aa +
        ((1 - t + c) * aa ** 3) / 6 +
        ((5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * aa ** 5) / 120) +
    500000
  const northing =
    k0 *
    (m +
      n *
        tanLat *
        ((aa ** 2) / 2 +
          ((5 - t + 9 * c + 4 * c ** 2) * aa ** 4) / 24 +
          ((61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * aa ** 6) / 720))

  return [easting, northing]
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/â€™S\b/g, "'s")
    .replace(/â€™s\b/g, "'s")
    .replace(/â€™/g, "'")
    .replace(/â€˜/g, "'")
    .replace(/â€œ/g, '"')
    .replace(/â€/g, '"')
    .replace(/â€“/g, '-')
    .replace(/â€”/g, '-')
}

function normalizeFeature(feature) {
  const props = feature.properties ?? {}
  const lon = Number(props.LONGITUDE ?? feature.geometry?.coordinates?.[0])
  const lat = Number(props.LATITUDE ?? feature.geometry?.coordinates?.[1])
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  const [x26910, y26910] = toUtm10Nad83(lon, lat)

  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [lon, lat],
    },
    properties: {
      x_26910: x26910,
      y_26910: y26910,
      name: cleanText(props.OCCUPANT_NAME),
      service_type: cleanText(props.SERVICE_TYPE_DESC),
      address: [props.STREET_ADDRESS, props.ADDRESS_LINE_2].filter(Boolean).map(cleanText).join(', '),
      postal_code: cleanText(props.POSTAL_CODE),
      fac_id: String(props.FACILITY_ID ?? props.SEQUENCE_ID ?? feature.id ?? ''),
      poi_class: 'Daycare',
    },
  }
}

async function main() {
  const sourceFeatures = await fetchLayer()
  const features = sourceFeatures
    .map(normalizeFeature)
    .filter(Boolean)
    .sort((a, b) => Number(a.properties.fac_id) - Number(b.properties.fac_id))

  const geojson = {
    type: 'FeatureCollection',
    name: 'bc_childcare_locations',
    crs: { type: 'name', properties: { name: 'EPSG:4326' } },
    features,
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    coverage: 'Prince George, BC',
    outputs: {
      walkabilitySupplement: '/data/walkability/supplemental/bc_childcare_locations.geojson',
      walkabilitySource: '/data/walkability/source/data/supplemental/bc_childcare_locations.geojson',
    },
    sources: {
      map: MAP_URL,
      arcgisLayer: LAYER_URL,
      metadata: METADATA_URL,
      csvResource: CSV_URL,
    },
    featureCount: features.length,
    license: 'Open Government Licence - British Columbia',
  }

  await mkdir(OUTPUT_DIR, { recursive: true })
  await writeFile(OUTPUT_GEOJSON, `${JSON.stringify(geojson)}\n`)
  await writeFile(OUTPUT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`BC child care: wrote ${features.length} features to ${OUTPUT_GEOJSON}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
