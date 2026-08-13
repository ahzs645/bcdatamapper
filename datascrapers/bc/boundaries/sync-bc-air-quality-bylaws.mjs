import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { simplifyPolygonTopology, TOPOLOGY_PROFILES } from '../../lib/mapshaper-topology.mjs'

const SOURCE_URL = 'https://www.env.gov.bc.ca/soe/indicators/air/aqbylaw_viz/data/bylaws.csv'
const INDICATOR_URL = 'https://www.env.gov.bc.ca/soe/indicators/air/air-quality-bylaws.html'
const SHARED_BOUNDARY_PATH = 'datascrapers/bc/boundaries/output/BC/regional_districts.geojson'
const OUTPUT_DIR = 'datascrapers/bc/boundaries/output/BCAirQuality'
const OUTPUT_NAME = 'air_quality_bylaws_2016.geojson'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const VENDOR_ROOT = join(SCRIPT_DIR, '..', '..', '..')

const REPORTING_NAMES = new Map([
  ['Capital Regional District', 'Capital'],
  ['Cariboo Regional District', 'Cariboo'],
  ['Central Coast Regional District', 'Central Coast'],
  ['Columbia Shuswap Regional District', 'Columbia-Shuswap'],
  ['Comox Valley Regional District', 'Comox Valley'],
  ['Cowichan Valley Regional District', 'Cowichan Valley'],
  ['Fraser Valley Regional District', 'Fraser Valley'],
  ['Metro Vancouver Regional District', 'Greater Vancouver'],
  ['North Coast Regional District', 'Skeena-Queen Charlotte'],
  ['Peace River Regional District', 'Peace River'],
  ['qathet Regional District', 'Powell River'],
  ['Regional District of Alberni-Clayoquot', 'Alberni-Clayoquot'],
  ['Regional District of Bulkley-Nechako', 'Bulkley-Nechako'],
  ['Regional District of Central Kootenay', 'Central Kootenay'],
  ['Regional District of Central Okanagan', 'Central Okanagan'],
  ['Regional District of East Kootenay', 'East Kootenay'],
  ['Regional District of Fraser-Fort George', 'Fraser-Fort George'],
  ['Regional District of Kitimat-Stikine', 'Kitimat-Stikine'],
  ['Regional District of Kootenay Boundary', 'Kootenay Boundary'],
  ['Regional District of Mount Waddington', 'Mount Waddington'],
  ['Regional District of Nanaimo', 'Nanaimo'],
  ['Regional District of North Okanagan', 'North Okanagan'],
  ['Regional District of Okanagan-Similkameen', 'Okanagan-Similkameen'],
  ['Squamish-Lillooet Regional District', 'Squamish-Lillooet'],
  ['Strathcona Regional District', 'Strathcona'],
  ['Sunshine Coast Regional District', 'Sunshine Coast'],
  ['Thompson-Nicola Regional District', 'Thompson-Nicola'],
])

const BYLAWS = [
  { key: 'vehicle_idling', column: 'Vehicle Idling', label: 'Vehicle idling' },
  { key: 'open_burning', column: 'Open Burning', label: 'Open burning' },
  { key: 'solid_fuel', column: 'Solid Fuel Burning Appliances', label: 'Solid fuel appliance' },
]

function parseCsv(text) {
  const records = []
  let record = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') quoted = false
      else field += character
    } else if (character === '"') quoted = true
    else if (character === ',') {
      record.push(field)
      field = ''
    } else if (character === '\n') {
      record.push(field.replace(/\r$/, ''))
      if (record.some(Boolean)) records.push(record)
      record = []
      field = ''
    } else field += character
  }
  if (field || record.length) {
    record.push(field.replace(/\r$/, ''))
    if (record.some(Boolean)) records.push(record)
  }
  const [headers, ...rows] = records
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])))
}

function coverageBand(percent) {
  if (percent === 0) return '0%'
  if (percent <= 25) return '1–25%'
  if (percent <= 50) return '26–50%'
  if (percent <= 75) return '51–75%'
  return 'More than 75%'
}

function addBylawProperties(properties, rows, bylaw) {
  const population = rows.reduce((sum, row) => sum + Number(row['Population 2015']), 0)
  const coveredRows = rows.filter((row) => row[bylaw.column] === '1')
  const coveredPopulation = coveredRows.reduce((sum, row) => sum + Number(row['Population 2015']), 0)
  const percent = population === 0 ? 0 : (coveredPopulation / population) * 100
  const rounded = Math.round(percent * 10) / 10
  properties[`${bylaw.key}_population`] = coveredPopulation
  properties[`${bylaw.key}_percent`] = rounded
  properties[`${bylaw.key}_band`] = coverageBand(percent)
  properties[`${bylaw.key}_display`] = `${properties.boundaryName} · ${rounded}% covered`
  properties[`${bylaw.key}_details`] = [
    `${bylaw.label}: ${rounded}% of the regional district population covered (2015 population estimate).`,
    ...rows.map((row) => `${row.Municipality.trim()}: ${row[bylaw.column] === '1' ? 'bylaw reported' : 'no bylaw reported'}`),
  ].join('\n')
}

const response = await fetch(SOURCE_URL)
if (!response.ok) throw new Error(`Failed to fetch air-quality bylaw table: ${response.status}`)
const csv = await response.text()
const rows = parseCsv(csv)
if (rows.length !== 188) throw new Error(`Expected 188 bylaw rows, received ${rows.length}`)

const rowsByDistrict = new Map()
for (const row of rows) {
  const district = row['Regional District']
  const districtRows = rowsByDistrict.get(district) ?? []
  districtRows.push(row)
  rowsByDistrict.set(district, districtRows)
}
if (rowsByDistrict.size !== 27) throw new Error(`Expected 27 reporting districts, received ${rowsByDistrict.size}`)

const sharedBoundaries = JSON.parse(readFileSync(join(VENDOR_ROOT, SHARED_BOUNDARY_PATH), 'utf8'))
const features = sharedBoundaries.features.flatMap((feature) => {
  const boundaryName = String(feature.properties?.boundaryName ?? '')
  const reportingName = REPORTING_NAMES.get(boundaryName)
  if (!reportingName) return []
  const districtRows = rowsByDistrict.get(reportingName)
  if (!districtRows) throw new Error(`No bylaw rows found for ${boundaryName} (${reportingName})`)
  const properties = {
    id: String(feature.properties.boundaryCode),
    boundaryCode: feature.properties.boundaryCode,
    boundaryName,
    reportingName,
    jurisdiction_count: districtRows.length,
    population_2015: districtRows.reduce((sum, row) => sum + Number(row['Population 2015']), 0),
  }
  for (const bylaw of BYLAWS) addBylawProperties(properties, districtRows, bylaw)
  return [{ type: 'Feature', id: properties.id, geometry: feature.geometry, properties }]
})
if (features.length !== 27) throw new Error(`Expected 27 mapped regional districts, received ${features.length}`)

const simplified = simplifyPolygonTopology({ type: 'FeatureCollection', features }, {
  toleranceMetres: 150,
  topologyProfile: TOPOLOGY_PROFILES.PARTITION,
  sourceCrs: 'EPSG:4326',
  workingCrs: 'EPSG:3005',
  outputCrs: 'EPSG:4326',
  coordinatePrecision: 6,
  tempPrefix: 'bc-air-quality-bylaws-',
})

const output = {
  type: 'FeatureCollection',
  name: 'air_quality_bylaws_2016',
  metadata: {
    title: 'Status of Air Quality Bylaws in B.C.',
    indicator: INDICATOR_URL,
    source: SOURCE_URL,
    reportingYear: 2016,
    populationYear: 2015,
    reusedBoundarySource: SHARED_BOUNDARY_PATH,
    excludedBoundary: 'Stikine Region (outside the 2016 indicator table)',
    simplificationToleranceMetres: 150,
  },
  features: simplified.features.sort((left, right) => left.properties.boundaryName.localeCompare(right.properties.boundaryName)),
}

const outputDir = join(VENDOR_ROOT, OUTPUT_DIR)
mkdirSync(outputDir, { recursive: true })
const payload = `${JSON.stringify(output)}\n`
writeFileSync(join(outputDir, OUTPUT_NAME), payload)
writeFileSync(join(outputDir, 'air_quality_bylaws_2016.csv'), csv)
writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify({
  source: SOURCE_URL,
  indicator: INDICATOR_URL,
  rows: rows.length,
  regionalDistricts: output.features.length,
  csvBytes: Buffer.byteLength(csv),
  geojsonBytes: Buffer.byteLength(payload),
  geojsonGzipBytes: gzipSync(payload).length,
  csvSha256: createHash('sha256').update(csv).digest('hex'),
}, null, 2)}\n`)

console.log(JSON.stringify({
  output: `${OUTPUT_DIR}/${OUTPUT_NAME}`,
  features: output.features.length,
  csvBytes: Buffer.byteLength(csv),
  geojsonBytes: Buffer.byteLength(payload),
  gzipBytes: gzipSync(payload).length,
}))
