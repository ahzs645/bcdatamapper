import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = join(SCRIPT_DIR, 'output', 'bc_bigtree_registry.geojson')
const REPORTS_URL = 'https://bigtrees.forestry.ubc.ca/registry-reports/'
const REGISTRY_URL = 'https://bigtrees.forestry.ubc.ca/bc-bigtree-registry/'

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function cleanString(value) {
  return typeof value === 'string' ? value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim() : ''
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function integerOrNull(value) {
  const parsed = numberOrNull(value)
  return parsed !== null && Number.isInteger(parsed) ? parsed : null
}

function photoUrl(value) {
  const match = cleanString(value).match(/href=["'](https:\/\/[^"']+)["']/i)
  return match?.[1] ?? null
}

function measurement(value, unit) {
  return value === null ? null : `${value.toLocaleString('en-CA')} ${unit}`
}

function heightBand(value) {
  if (value === null) return 'Height unavailable'
  if (value < 40) return 'Under 40 m'
  if (value < 60) return '40–59.9 m'
  if (value < 80) return '60–79.9 m'
  return '80 m or taller'
}

function dbhBand(value) {
  if (value === null) return 'DBH unavailable'
  if (value < 1) return 'Under 1 m'
  if (value < 2) return '1–1.99 m'
  if (value < 3) return '2–2.99 m'
  if (value < 4) return '3–3.99 m'
  return '4 m or wider'
}

function scoreBand(value) {
  if (value === null) return 'Score unavailable'
  if (value < 350) return 'Under 350'
  if (value < 500) return '350–499'
  if (value < 650) return '500–649'
  return '650 or higher'
}

function normalizeFeature(feature) {
  if (feature?.type !== 'Feature' || feature.geometry?.type !== 'Point') {
    throw new Error('Every BigTree Registry feature must be a GeoJSON Point')
  }
  const coordinates = feature.geometry.coordinates
  if (
    !Array.isArray(coordinates) ||
    coordinates.length < 2 ||
    !Number.isFinite(coordinates[0]) ||
    !Number.isFinite(coordinates[1]) ||
    coordinates[0] < -140 ||
    coordinates[0] > -110 ||
    coordinates[1] < 47 ||
    coordinates[1] > 61
  ) {
    throw new Error(`Invalid B.C. point coordinates: ${JSON.stringify(coordinates)}`)
  }

  const source = feature.properties ?? {}
  const registryId = cleanString(source.tree_registry_id)
  if (!registryId) throw new Error('Every BigTree Registry feature must have tree_registry_id')

  const commonName = cleanString(source.common_name) || 'Unknown species'
  const nickname = cleanString(source.tree_nickname)
  const sourceTreeType = cleanString(source.tree_type).toLowerCase()
  const treeType = sourceTreeType === 'coniferous' ? 'Conifer' : sourceTreeType === 'deciduous' ? 'Broadleaf' : 'Unknown'
  const rank = integerOrNull(source.rank)
  const score = numberOrNull(source.tree_score)
  const heightMetres = numberOrNull(source['height_(m)'])
  const dbhMetres = numberOrNull(source['DBH_(m)'])
  const crownSpreadMetres = numberOrNull(source['crown_spread_(m)'])
  const nearestTown = cleanString(source.nearest_town)
  const location = cleanString(source.location)
  const ownership = cleanString(source.ownership)
  const ownershipDetails = cleanString(source.ownership_details)
  const title = nickname || `${commonName} · Registry ${registryId}`
  const display = nickname ? `${nickname} · ${commonName}` : `${commonName} · Registry ${registryId}`

  const dimensions = [
    heightMetres === null ? '' : `Height ${measurement(heightMetres, 'm')}`,
    dbhMetres === null ? '' : `DBH ${measurement(dbhMetres, 'm')}`,
    crownSpreadMetres === null ? '' : `crown spread ${measurement(crownSpreadMetres, 'm')}`,
  ].filter(Boolean)
  const detailLines = [
    `Registry ID: ${registryId}`,
    `Species: ${commonName} (${treeType.toLowerCase()})`,
    rank === null ? '' : `Species rank: #${rank}`,
    score === null ? '' : `Tree score: ${score.toLocaleString('en-CA')}`,
    dimensions.length === 0 ? '' : dimensions.join(' · '),
    nearestTown ? `Nearest town: ${nearestTown}` : '',
    location ? `Location: ${location}` : '',
    ownership ? `Ownership: ${[ownership, ownershipDetails].filter(Boolean).join(' · ')}` : '',
    cleanString(source.last_measured) ? `Last measured: ${cleanString(source.last_measured)}` : '',
    cleanString(source.tree_site_notes) ? `Site notes: ${cleanString(source.tree_site_notes)}` : '',
    cleanString(source.access_notes) ? `Access notes: ${cleanString(source.access_notes)}` : '',
  ].filter(Boolean)

  return {
    type: 'Feature',
    id: registryId,
    geometry: {
      type: 'Point',
      coordinates: [Number(coordinates[0].toFixed(6)), Number(coordinates[1].toFixed(6))],
    },
    properties: {
      tree_registry_id: registryId,
      title,
      display,
      details: detailLines.join('\n'),
      common_name: commonName,
      tree_nickname: nickname || null,
      tree_type: treeType,
      location_coverage: location ? 'Named location + nearest town' : 'Nearest town only',
      rank,
      rank_class: rank === 1 ? 'Species champion' : 'Other registry tree',
      tree_score: score,
      height_m: heightMetres,
      height_band: heightBand(heightMetres),
      dbh_m: dbhMetres,
      dbh_band: dbhBand(dbhMetres),
      highside_dbh_m: numberOrNull(source['highside_DBH(m)']),
      crown_spread_m: crownSpreadMetres,
      score_band: scoreBand(score),
      elevation_m: numberOrNull(source.elevation_m),
      height_rank: integerOrNull(source.height_rank),
      top_lists: integerOrNull(source.top_lists),
      species_code: cleanString(source.tree_sp_code) || null,
      bcptpr_status: cleanString(source.bcptpr_status) || null,
      last_measured: cleanString(source.last_measured) || null,
      year_nominated: cleanString(source.year_nominated) || null,
      location: location || null,
      nearest_town: nearestTown || null,
      ownership: ownership || null,
      ownership_details: ownershipDetails || null,
      access_notes: cleanString(source.access_notes) || null,
      site_notes: cleanString(source.tree_site_notes) || null,
      principal_nominator: cleanString(source['Principle nominator']) || null,
      co_nominator_1: cleanString(source['Co-nominator 1']) || null,
      co_nominator_2: cleanString(source['Co-nominator 2']) || null,
      co_nominator_3: cleanString(source['Co-nominator 3']) || null,
      verifier: cleanString(source.Verifier) || null,
      datum: cleanString(source.datum) || null,
      has_photo: source.has_photo === true || cleanString(source.has_photo) === '1',
      photo_url: photoUrl(source['all photo LINK']),
    },
  }
}

function compareRegistryIds(left, right) {
  const leftNumber = Number(left.properties.tree_registry_id)
  const rightNumber = Number(right.properties.tree_registry_id)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber
  return left.properties.tree_registry_id.localeCompare(right.properties.tree_registry_id)
}

const inputPath = option('--input')
const snapshotDate = option('--snapshot-date')
if (!inputPath || !snapshotDate || !/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
  throw new Error('Usage: import-big-tree-registry.mjs --input /path/to/registry.geojson --snapshot-date YYYY-MM-DD')
}

const sourceBytes = await readFile(inputPath)
const source = JSON.parse(sourceBytes.toString('utf8'))
if (source?.type !== 'FeatureCollection' || !Array.isArray(source.features) || source.features.length < 100) {
  throw new Error('Expected a BigTree Registry GeoJSON FeatureCollection with at least 100 features')
}

const features = source.features.map(normalizeFeature).sort(compareRegistryIds)
const ids = features.map((feature) => feature.properties.tree_registry_id)
if (new Set(ids).size !== ids.length) throw new Error('BigTree Registry IDs must be unique')

const longitudes = features.map((feature) => feature.geometry.coordinates[0])
const latitudes = features.map((feature) => feature.geometry.coordinates[1])
const counts = {
  features: features.length,
  conifers: features.filter((feature) => feature.properties.tree_type === 'Conifer').length,
  broadleaves: features.filter((feature) => feature.properties.tree_type === 'Broadleaf').length,
  speciesChampions: features.filter((feature) => feature.properties.rank === 1).length,
  withPhotos: features.filter((feature) => feature.properties.has_photo).length,
  withNamedLocation: features.filter((feature) => feature.properties.location).length,
  nearestTownOnly: features.filter((feature) => !feature.properties.location).length,
  withHeight: features.filter((feature) => feature.properties.height_m !== null).length,
  withDbh: features.filter((feature) => feature.properties.dbh_m !== null).length,
  withScore: features.filter((feature) => feature.properties.tree_score !== null).length,
}

const output = {
  type: 'FeatureCollection',
  name: 'bc_bigtree_registry',
  metadata: {
    title: 'BC BigTree Registry',
    snapshotDate,
    sourceKind: 'BC Forest Map GeoJSON fallback snapshot',
    sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
    upstreamReportsUrl: REPORTS_URL,
    upstreamRegistryUrl: REGISTRY_URL,
    sourceCrs: 'EPSG:4326 (inferred from longitude/latitude)',
    outputCrs: 'EPSG:4326',
    coordinatePrecision: 6,
    counts,
    bounds: [Math.min(...longitudes), Math.min(...latitudes), Math.max(...longitudes), Math.max(...latitudes)],
    note: 'UBC Registry Reports is the source of record. This deterministic fallback was normalized from the supplied BC Forest Map snapshot because unattended UBC CSV requests can encounter bot protection.',
  },
  features,
}

const payload = `${JSON.stringify(output)}\n`
await mkdir(dirname(OUTPUT_PATH), { recursive: true })
await writeFile(OUTPUT_PATH, payload)
console.log(JSON.stringify({
  output: OUTPUT_PATH,
  ...counts,
  bytes: Buffer.byteLength(payload),
  gzipBytes: gzipSync(payload).length,
  bounds: output.metadata.bounds,
}))
