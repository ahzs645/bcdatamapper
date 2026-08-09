import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = join(HERE, 'output')
const BASIN_BOUNDARY_PATH = join(HERE, '..', 'boundaries', 'output', 'BCSnowSurvey', 'snow_survey_admin_basins.geojson')
const BASIN_BOUNDARY_REPOSITORY_PATH = 'datascrapers/bc/boundaries/output/BCSnowSurvey/snow_survey_admin_basins.geojson'
const BASIN_BOUNDARY_DATASET_ID = 'bc-snow-survey-admin-basins'
const OGL_BC = 'https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61'
const BASE_WFS = 'https://openmaps.gov.bc.ca/geo/pub'
const LAYERS = {
  manual: 'WHSE_WATER_MANAGEMENT.SSL_SNOW_MSS_LOCS_SP',
  automated: 'WHSE_WATER_MANAGEMENT.SSL_SNOW_ASWS_STNS_SP',
}
const CATALOGUES = {
  manual: 'https://catalogue.data.gov.bc.ca/dataset/9f653102-5627-45a7-bd4c-686e365ee04a',
  automated: 'https://catalogue.data.gov.bc.ca/dataset/ebe546aa-ac34-491c-a828-fdc87fb70610',
  current: 'https://catalogue.data.gov.bc.ca/dataset/12472805-6f6d-457b-8db2-5c1f42a00099',
  archive: 'https://catalogue.data.gov.bc.ca/dataset/705df46f-e9d6-4124-bc4a-66f54c07b228',
}
const CURRENT_CSV = 'https://www.env.gov.bc.ca/wsd/data_searches/snow/asws/data/allmss_current.csv'
const ARCHIVE_CSV = 'https://www.env.gov.bc.ca/wsd/data_searches/snow/asws/data/allmss_archive.csv'
const NO_SWE_REPORT = new Set(['2A33P', '2B10P', '2C21P', '4A35P', '2D15P', '2D16P', '3A29P'])

function wfsUrl(layer) {
  const url = new URL(`${BASE_WFS}/${layer}/ows`)
  url.search = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: layer,
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
  })
  return url.href
}

async function fetchResponse(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120000),
    headers: { 'user-agent': 'bcdatamapper snow-survey sync/1.0' },
  })
  if (!response.ok) throw new Error(`Request failed ${response.status}: ${url}`)
  return response
}

async function fetchJson(url) {
  return (await fetchResponse(url)).json()
}

async function fetchText(url) {
  return (await fetchResponse(url)).text()
}

function pointInRing([x, y], ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function pointInPolygon(point, polygon) {
  return polygon.length > 0 && pointInRing(point, polygon[0]) && !polygon.slice(1).some((hole) => pointInRing(point, hole))
}

function geometryContainsPoint(geometry, point) {
  if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates)
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((polygon) => pointInPolygon(point, polygon))
  return false
}

function geometryBounds(geometry) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity]
  function visit(value) {
    if (!Array.isArray(value)) return
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      bounds[0] = Math.min(bounds[0], value[0])
      bounds[1] = Math.min(bounds[1], value[1])
      bounds[2] = Math.max(bounds[2], value[0])
      bounds[3] = Math.max(bounds[3], value[1])
      return
    }
    for (const child of value) visit(child)
  }
  visit(geometry.coordinates)
  return bounds
}

function basinForPoint(point, basinFeatures) {
  const matches = basinFeatures.filter((feature) => geometryContainsPoint(feature.geometry, point))
  matches.sort((a, b) => Number(a.properties.source_area_sq_m) - Number(b.properties.source_area_sq_m))
  return matches[0]?.properties.basin_id ?? null
}

function stationLinks(type, locationId) {
  const encoded = encodeURIComponent(locationId)
  const common = {
    data_explorer_url: `https://bcmoe-prod.aquaticinformatics.net/Data/Location/Summary/Location/${encoded}/Interval/Latest`,
  }
  if (type === 'manual') {
    return { ...common, summary_report_url: `https://bcmoe-prod.aquaticinformatics.net/Report/Show/SnowMSS.${encoded}.MSS%20Report/`, weekly_report_url: null, snow_water_equivalent_report_url: null }
  }
  return {
    ...common,
    summary_report_url: null,
    weekly_report_url: `https://bcmoe-prod.aquaticinformatics.net/Report/Show/Snow.${encoded}.Weekly%20Report/`,
    snow_water_equivalent_report_url: NO_SWE_REPORT.has(locationId) ? null : `https://bcmoe-prod.aquaticinformatics.net/Report/Show/Snow.${encoded}.Automated%20Snow%20Weather%20Station%20Graph/`,
  }
}

function normalizeStation(feature, type, basinFeatures) {
  const source = feature.properties
  const locationId = String(source.LOCATION_ID)
  const status = String(source.STATUS || '')
  const point = feature.geometry.coordinates
  return {
    type: 'Feature',
    id: `${type}:${locationId}`,
    properties: {
      station_id: `${type}:${locationId}`,
      station_type: type,
      location_id: locationId,
      name: source.LOCATION_NAME,
      status,
      active: status.toLowerCase().startsWith('active'),
      elevation_m: source.ELEVATION,
      operator: source.OPERATOR || null,
      camera_url: source.CAMERA_URL || null,
      basin_id: basinForPoint(point, basinFeatures),
      source_object_id: source.OBJECTID,
      source_record_id: type === 'manual' ? source.SNOW_MSS_LOC_ID : source.SNOW_ASWS_STN_ID,
      source_layer: LAYERS[type],
      ...stationLinks(type, locationId),
    },
    geometry: feature.geometry,
  }
}

function featureCollection(features) {
  return { type: 'FeatureCollection', features }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function countCsvRows(csv) {
  const normalized = csv.trimEnd()
  return normalized ? Math.max(0, normalized.split(/\r?\n/).length - 1) : 0
}

function parseCsv(csv) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]
    const next = csv[index + 1]
    if (quoted) {
      if (character === '"' && next === '"') {
        field += '"'
        index += 1
      } else if (character === '"') quoted = false
      else field += character
    } else if (character === '"') quoted = true
    else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''))
      rows.push(row)
      row = []
      field = ''
    } else field += character
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  const headers = (rows.shift() || []).map((header) => header.trim())
  return rows
    .filter((values) => values.some(Boolean))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, String(values[index] ?? '').trim()])))
}

function validateCollection(collection, expectedGeometry, idAccessor) {
  if (!Array.isArray(collection.features) || collection.features.length === 0) throw new Error('Empty source collection')
  const ids = collection.features.map(idAccessor)
  if (ids.some((id) => id == null || id === '')) throw new Error('Missing source identifier')
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate source identifier')
  if (collection.features.some((feature) => !expectedGeometry.includes(feature.geometry?.type))) throw new Error('Unexpected geometry type')
}

await mkdir(OUTPUT_DIR, { recursive: true })
const [basinBoundaryText, rawManual, rawAutomated, currentCsv, archiveCsv] = await Promise.all([
  readFile(BASIN_BOUNDARY_PATH, 'utf8'),
  fetchJson(wfsUrl(LAYERS.manual)),
  fetchJson(wfsUrl(LAYERS.automated)),
  fetchText(CURRENT_CSV),
  fetchText(ARCHIVE_CSV),
])
const basinBoundary = JSON.parse(basinBoundaryText)
if (basinBoundary.metadata?.boundaryDatasetId !== BASIN_BOUNDARY_DATASET_ID) {
  throw new Error(`Expected canonical boundary dataset ${BASIN_BOUNDARY_DATASET_ID}; run npm run snow-survey-basins:sync first`)
}
validateCollection(basinBoundary, ['Polygon', 'MultiPolygon'], (feature) => feature.properties.basin_id)
validateCollection(rawManual, ['Point'], (feature) => feature.properties.LOCATION_ID)
validateCollection(rawAutomated, ['Point'], (feature) => feature.properties.LOCATION_ID)

const basins = basinBoundary.features
  .slice()
  .sort((a, b) => a.properties.basin_id.localeCompare(b.properties.basin_id, undefined, { numeric: true }))
const manual = rawManual.features.map((feature) => normalizeStation(feature, 'manual', basins)).sort((a, b) => a.properties.location_id.localeCompare(b.properties.location_id))
const automated = rawAutomated.features.map((feature) => normalizeStation(feature, 'automated', basins)).sort((a, b) => a.properties.location_id.localeCompare(b.properties.location_id))
const stations = [...manual, ...automated].sort((a, b) => a.properties.station_id.localeCompare(b.properties.station_id))
const manualByLocationId = new Map(manual.map((feature) => [feature.properties.location_id, feature.properties]))
const currentRows = parseCsv(currentCsv)
const archiveRows = parseCsv(archiveCsv)
const observationsByBasin = (rows) => {
  const result = new Map()
  for (const row of rows) {
    const basinId = manualByLocationId.get(row.Number)?.basin_id
    if (!basinId) continue
    const entry = result.get(basinId) ?? { observations: 0, station_ids: new Set() }
    entry.observations += 1
    entry.station_ids.add(row.Number)
    result.set(basinId, entry)
  }
  return result
}
const currentByBasin = observationsByBasin(currentRows)
const archiveByBasin = observationsByBasin(archiveRows)
const basinProjectIndex = basins.map((basin) => {
  const basinId = basin.properties.basin_id
  const basinStations = stations.filter((station) => station.properties.basin_id === basinId)
  const manualStations = basinStations.filter((station) => station.properties.station_type === 'manual')
  const automatedStations = basinStations.filter((station) => station.properties.station_type === 'automated')
  const current = currentByBasin.get(basinId)
  const archive = archiveByBasin.get(basinId)
  const compactSlug = basin.properties.compact_slug
  const state = basinStations.length === 0
    ? 'coverage-gap'
    : current?.observations
      ? 'current-manual-observations'
      : 'historical-or-automated-only'
  return {
    basin_id: basinId,
    boundary_dataset_id: BASIN_BOUNDARY_DATASET_ID,
    boundary_feature_id: basin.id,
    title: basin.properties.basin_name,
    slug: basin.properties.slug,
    route: `/bcsnowpack/${basin.properties.slug}`,
    route_aliases: compactSlug === basin.properties.slug ? [] : [`/bcsnowpack/${compactSlug}`],
    state,
    bounds_wgs84: geometryBounds(basin.geometry),
    counts: {
      manual_stations: manualStations.length,
      manual_active: manualStations.filter((station) => station.properties.active).length,
      automated_stations: automatedStations.length,
      automated_active: automatedStations.filter((station) => station.properties.active).length,
      current_manual_observations: current?.observations ?? 0,
      current_manual_sites: current?.station_ids.size ?? 0,
      archived_manual_observations: archive?.observations ?? 0,
      archived_manual_sites: archive?.station_ids.size ?? 0,
    },
  }
}).sort((a, b) => a.title.localeCompare(b.title))

const outputs = {
  'manual-stations.geojson': `${JSON.stringify(featureCollection(manual))}\n`,
  'automated-stations.geojson': `${JSON.stringify(featureCollection(automated))}\n`,
  'stations.geojson': `${JSON.stringify(featureCollection(stations))}\n`,
  'manual-current.csv': currentCsv.endsWith('\n') ? currentCsv : `${currentCsv}\n`,
}
const archiveGzip = gzipSync(Buffer.from(archiveCsv), { level: 9, mtime: 0 })
const stationIndex = stations.map(({ properties }) => properties)
outputs['station-series-index.json'] = `${JSON.stringify(stationIndex, null, 2)}\n`
outputs['basin-project-index.json'] = `${JSON.stringify(basinProjectIndex, null, 2)}\n`

const manifest = {
  title: 'BC Snow Survey project snapshot',
  license: { title: 'Open Government Licence - British Columbia', url: OGL_BC },
  geometry: {
    crs: 'EPSG:4326',
    note: 'Station points use WGS84. Project polygons come from the canonical Snow Survey boundary dataset and are not duplicated in this output.',
    boundary_dataset_id: BASIN_BOUNDARY_DATASET_ID,
    boundary_repository_path: BASIN_BOUNDARY_REPOSITORY_PATH,
    boundary_public_path: '/data/boundaries/BCSnowSurvey/snow_survey_admin_basins.geojson',
  },
  sources: {
    basins: {
      boundary_dataset_id: BASIN_BOUNDARY_DATASET_ID,
      repository_path: BASIN_BOUNDARY_REPOSITORY_PATH,
      source_metadata: basinBoundary.metadata,
    },
    manual_stations: { layer: LAYERS.manual, wfs_url: wfsUrl(LAYERS.manual), catalogue_url: CATALOGUES.manual },
    automated_stations: { layer: LAYERS.automated, wfs_url: wfsUrl(LAYERS.automated), catalogue_url: CATALOGUES.automated },
    current_manual_observations: { url: CURRENT_CSV, catalogue_url: CATALOGUES.current },
    archived_manual_observations: { url: ARCHIVE_CSV, catalogue_url: CATALOGUES.archive },
    observation_link_templates: { source_web_map_item: 'f1daea2c0ff846f7b63cfcc066d6d16e', snapshot_policy: 'outbound-links-only' },
  },
  counts: {
    basins: basins.length,
    manual_stations: manual.length,
    manual_active: manual.filter((feature) => feature.properties.active).length,
    manual_inactive: manual.filter((feature) => !feature.properties.active).length,
    automated_stations: automated.length,
    automated_active: automated.filter((feature) => feature.properties.active).length,
    automated_inactive: automated.filter((feature) => !feature.properties.active).length,
    automated_with_camera: automated.filter((feature) => feature.properties.camera_url).length,
    stations_with_basin_assignment: stations.filter((feature) => feature.properties.basin_id).length,
    basin_subprojects: basinProjectIndex.length,
    basin_subprojects_with_current_manual_observations: basinProjectIndex.filter((basin) => basin.state === 'current-manual-observations').length,
    current_manual_observations: countCsvRows(currentCsv),
    archived_manual_observations: countCsvRows(archiveCsv),
  },
  limitations: [
    'The observation CSV contains no percent-normal field.',
    'Automated live observations remain outbound links and are not mirrored.',
    'Station basin assignment is a point-in-polygon convenience field and should be reviewed at basin boundaries.',
  ],
  routing: {
    base_path: '/bcsnowpack',
    canonical_slug_style: 'kebab-case',
    compact_slug_aliases: true,
    example: '/bcsnowpack/upper-columbia',
    example_alias: '/bcsnowpack/uppercolumbia',
  },
  files: {},
}
for (const [name, value] of Object.entries(outputs)) manifest.files[name] = { bytes: Buffer.byteLength(value), sha256: sha256(value) }
manifest.files['manual-archive.csv.gz'] = { bytes: archiveGzip.length, sha256: sha256(archiveGzip) }
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`

await Promise.all([
  ...Object.entries(outputs).map(([name, value]) => writeFile(join(OUTPUT_DIR, name), value)),
  writeFile(join(OUTPUT_DIR, 'manual-archive.csv.gz'), archiveGzip),
  writeFile(join(OUTPUT_DIR, 'manifest.json'), manifestText),
  rm(join(OUTPUT_DIR, 'snow-basins.geojson'), { force: true }),
])
console.log(JSON.stringify(manifest, null, 2))
