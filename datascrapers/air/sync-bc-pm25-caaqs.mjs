import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = join(SCRIPT_DIR, 'output', 'bc')
const ASSESSMENT_PERIOD = '2022–2024'

const INDICATORS = [
  {
    key: 'pm25',
    label: 'PM₂.₅',
    title: 'Status of Fine Particulate Matter in B.C.',
    pageUrl: 'https://www.env.gov.bc.ca/soe/indicators/air/fine-pm.html',
    mapUrl: 'https://www.env.gov.bc.ca/soe/indicators/air/pm25_viz/leaflet_map.html',
    expectedStations: 57,
  },
  {
    key: 'ozone',
    label: 'Ozone',
    title: 'Status of Ground-Level Ozone in B.C.',
    pageUrl: 'https://www.env.gov.bc.ca/soe/indicators/air/ozone.html',
    mapUrl: 'https://www.env.gov.bc.ca/soe/indicators/air/ozone_viz/leaflet_map.html',
    expectedStations: 46,
  },
  {
    key: 'so2',
    label: 'SO₂',
    title: 'Status of Sulphur Dioxide in B.C.',
    pageUrl: 'https://www.env.gov.bc.ca/soe/indicators/air/so2.html',
    mapUrl: 'https://www.env.gov.bc.ca/soe/indicators/air/so2_viz/leaflet_map.html',
    expectedStations: 38,
  },
  {
    key: 'no2',
    label: 'NO₂',
    title: 'Status of Nitrogen Dioxide in B.C.',
    pageUrl: 'https://www.env.gov.bc.ca/soe/indicators/air/no2.html',
    mapUrl: 'https://www.env.gov.bc.ca/soe/indicators/air/no2_viz/leaflet_map.html',
    expectedStations: 49,
  },
]

const MANAGEMENT_BY_COLOR = new Map([
  ['#A50026', 'Actions for Achieving Air Zone CAAQS'],
  ['#F46D43', 'Actions for Preventing CAAQS Exceedance'],
  ['#FEE08B', 'Actions for Preventing Air Quality Deterioration'],
  ['#A6D96A', 'Actions for Keeping Clean Areas Clean'],
  ['#DBDBDB', 'Insufficient Data'],
  ['#808080', 'Insufficient Data'],
])

const MANAGEMENT_BY_ICON = new Map([
  ['marker_red.svg', 'Actions for Achieving Air Zone CAAQS'],
  ['marker_orange.svg', 'Actions for Preventing CAAQS Exceedance'],
  ['marker_yellow.svg', 'Actions for Preventing Air Quality Deterioration'],
  ['marker_green.svg', 'Actions for Keeping Clean Areas Clean'],
])

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function polygonCoordinates(rawFeature) {
  return rawFeature.map((polygon) => polygon.map((ring) => {
    if (!Array.isArray(ring?.lng) || !Array.isArray(ring?.lat) || ring.lng.length !== ring.lat.length) {
      throw new Error('Unexpected air-zone coordinate structure')
    }
    const coordinates = ring.lng.map((longitude, index) => [longitude, ring.lat[index]])
    const first = coordinates[0]
    const last = coordinates.at(-1)
    if (first && last && (first[0] !== last[0] || first[1] !== last[1])) coordinates.push(first)
    return coordinates
  }))
}

function cleanHtml(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:h[1-6]|p|tr|table|div)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&mu;/g, 'µ')
    .replace(/&sup3;/g, '³')
    .replace(/&ndash;/g, '–')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function iconNames(iconUrl) {
  const names = iconUrl.data.map((dataUrl) => {
    const svg = Buffer.from(dataUrl.split(',')[1], 'base64').toString('utf8')
    const name = svg.match(/sodipodi:docname="([^"]+)"/)?.[1]
    if (!name) throw new Error('Could not identify a station marker icon')
    return name
  })
  return iconUrl.index.map((index) => names[index])
}

async function loadIndicator(indicator) {
  const response = await fetch(indicator.mapUrl)
  if (!response.ok) throw new Error(`Failed to fetch ${indicator.label} map: ${response.status}`)
  const html = await response.text()
  const widgetMatch = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/)
  if (!widgetMatch) throw new Error(`Could not find the ${indicator.label} Leaflet widget payload`)
  const widget = JSON.parse(widgetMatch[1])
  const polygonCall = widget?.x?.calls?.find((call) => call?.method === 'addPolygons')
  const markerCall = widget?.x?.calls?.find((call) => call?.method === 'addMarkers')
  if (!polygonCall || !markerCall) throw new Error(`${indicator.label} map is missing its zone or station layer`)
  if (polygonCall.args[0].length !== 7 || markerCall.args[0].length !== indicator.expectedStations) {
    throw new Error(`Unexpected ${indicator.label} map counts`)
  }
  return { indicator, polygonCall, markerCall }
}

const loaded = await Promise.all(INDICATORS.map(loadIndicator))
const canonicalRawZones = loaded[0].polygonCall.args[0]
const canonicalGeometry = JSON.stringify(canonicalRawZones)
for (const { indicator, polygonCall } of loaded.slice(1)) {
  if (JSON.stringify(polygonCall.args[0]) !== canonicalGeometry) {
    throw new Error(`${indicator.label} air-zone geometry differs from the shared CAAQS boundary`)
  }
}

const zoneFeatures = canonicalRawZones.map((rawZone, zoneIndex) => {
  const properties = { id: '', name: '' }
  for (const { indicator, polygonCall } of loaded) {
    const [, , , zoneStyles, zonePopups, , zoneLabels] = polygonCall.args
    const label = String(zoneLabels[zoneIndex]).replace(/<br\s*\/?>/gi, '\n')
    const [name, countLine] = label.split('\n')
    const stationCount = Number(countLine.match(/\d+/)?.[0] ?? 0)
    const sourceColor = String(zoneStyles.fillColor[zoneIndex]).toUpperCase()
    const managementLevel = MANAGEMENT_BY_COLOR.get(sourceColor)
    if (!managementLevel) throw new Error(`Unexpected ${indicator.label} zone colour: ${sourceColor}`)
    if (!properties.id) {
      properties.id = slug(name)
      properties.name = name
    } else if (properties.name !== name) {
      throw new Error(`Air-zone order differs for ${indicator.label}: expected ${properties.name}, received ${name}`)
    }
    const popup = cleanHtml(Array.isArray(zonePopups) ? zonePopups[zoneIndex] : null)
    properties[`${indicator.key}_display`] = `${name} · ${stationCount} monitoring station${stationCount === 1 ? '' : 's'}`
    properties[`${indicator.key}_station_count`] = stationCount
    properties[`${indicator.key}_management_level`] = managementLevel
    properties[`${indicator.key}_source_color`] = sourceColor
    properties[`${indicator.key}_details`] = [
      `${indicator.label} management level: ${managementLevel}.`,
      popup || `Monitoring stations represented in this air-zone assessment: ${stationCount}.`,
    ].join('\n')
  }
  return {
    type: 'Feature',
    id: properties.id,
    properties,
    geometry: { type: 'MultiPolygon', coordinates: polygonCoordinates(rawZone) },
  }
})

function stationCollection({ indicator, markerCall }) {
  const [latitudes, longitudes, iconOptions, , , , markerPopups, , , , stationNames] = markerCall.args
  const stationIconNames = iconNames(iconOptions.iconUrl)
  const features = stationNames.map((stationName, index) => {
    const details = cleanHtml(markerPopups[index])
    const airZone = details.match(/Air Zone:\s*([^\n]+)/)?.[1]?.trim() ?? 'Unknown air zone'
    const managementLevel = MANAGEMENT_BY_ICON.get(stationIconNames[index])
    if (!managementLevel) throw new Error(`Unexpected ${indicator.label} station icon: ${stationIconNames[index]}`)
    return {
      type: 'Feature',
      id: slug(stationName),
      properties: {
        id: slug(stationName),
        name: stationName,
        display: `${stationName} · ${airZone}`,
        air_zone: airZone,
        management_level: managementLevel,
        details,
      },
      geometry: { type: 'Point', coordinates: [longitudes[index], latitudes[index]] },
    }
  })
  if (new Set(features.map((feature) => feature.properties.id)).size !== features.length) {
    throw new Error(`${indicator.label} station identifiers are not unique`)
  }
  return {
    type: 'FeatureCollection',
    name: `${indicator.key}_caaqs_stations_2022_2024`,
    metadata: {
      title: indicator.title,
      indicator: indicator.pageUrl,
      source: indicator.mapUrl,
      assessmentPeriod: ASSESSMENT_PERIOD,
      updated: 'June 2026',
      standard: `Canadian Ambient Air Quality Standards for ${indicator.label}`,
    },
    features,
  }
}

const sharedZones = {
  type: 'FeatureCollection',
  name: 'bc_caaqs_air_zones_2022_2024',
  metadata: {
    title: 'B.C. CAAQS Air Zones',
    assessmentPeriod: ASSESSMENT_PERIOD,
    updated: 'June 2026',
    indicators: Object.fromEntries(INDICATORS.map((indicator) => [indicator.key, indicator.mapUrl])),
    geometryReuse: 'All four provincial indicator maps contained byte-identical air-zone coordinate payloads.',
  },
  features: zoneFeatures,
}

const outputs = [
  ['caaqs-2022-2024-air-zones.geojson', sharedZones],
  ...loaded.map((entry) => [`${entry.indicator.key}-caaqs-2022-2024-stations.geojson`, stationCollection(entry)]),
]

mkdirSync(OUTPUT_DIR, { recursive: true })
const report = {}
for (const [filename, geojson] of outputs) {
  const payload = `${JSON.stringify(geojson)}\n`
  writeFileSync(join(OUTPUT_DIR, filename), payload)
  report[filename] = {
    features: geojson.features.length,
    bytes: Buffer.byteLength(payload),
    gzipBytes: gzipSync(payload).length,
  }
}
console.log(JSON.stringify(report))
