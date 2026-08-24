import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { VectorTile } from '@mapbox/vector-tile'
import Pbf from 'pbf'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = join(SCRIPT_DIR, 'output', 'species-at-risk', 'inaturalist_species_at_risk.geojson')

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

async function walkPbfFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walkPbfFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.pbf')) files.push(path)
  }
  return files
}

function parseTileCoordinates(path) {
  const parts = path.split(sep)
  const y = Number(parts.at(-1)?.replace(/\.pbf$/, ''))
  const x = Number(parts.at(-2))
  const z = Number(parts.at(-3))
  if (![z, x, y].every(Number.isInteger)) throw new Error(`Cannot derive z/x/y from tile path: ${path}`)
  return { z, x, y }
}

function taxonGroup(value) {
  const labels = {
    Plantae: 'Plants',
    Aves: 'Birds',
    Amphibia: 'Amphibians',
    Mammalia: 'Mammals',
    Reptilia: 'Reptiles',
    Actinopterygii: 'Ray-finned fishes',
    Insecta: 'Insects',
    Arachnida: 'Arachnids',
    Mollusca: 'Molluscs',
    Fungi: 'Fungi',
    Animalia: 'Other animals',
    Protozoa: 'Protozoans',
  }
  return labels[cleanString(value)] ?? 'Other taxa'
}

function observationPeriod(value) {
  const year = Number(cleanString(value).slice(0, 4))
  if (!Number.isInteger(year)) return 'Date unavailable'
  if (year < 2010) return 'Before 2010'
  if (year < 2016) return '2010–2015'
  if (year < 2019) return '2016–2018'
  return '2019–2021'
}

function accuracyBand(value) {
  if (value === null) return 'Accuracy unavailable'
  if (value < 10) return 'Under 10 m'
  if (value < 25) return '10–24 m'
  if (value < 50) return '25–49 m'
  return '50–99 m'
}

function observationFrequencyBand(value) {
  if (value >= 500) return '500 or more observations'
  if (value >= 100) return '100–499 observations'
  if (value >= 20) return '20–99 observations'
  return 'Under 20 observations'
}

function normalizeStatus(value) {
  const status = value && typeof value === 'object' ? value : null
  return {
    code: cleanString(status?.status) || null,
    name: cleanString(status?.status_name) || null,
    authority: cleanString(status?.authority) || null,
  }
}

function normalizeFeature(feature) {
  const properties = feature.properties ?? {}
  const observationId = cleanString(String(properties.id ?? ''))
  if (!observationId) throw new Error('Every iNaturalist feature must have an observation ID')
  const coordinates = feature.geometry?.coordinates
  if (
    feature.geometry?.type !== 'Point' ||
    !Array.isArray(coordinates) ||
    !Number.isFinite(coordinates[0]) ||
    !Number.isFinite(coordinates[1]) ||
    coordinates[0] < -141 || coordinates[0] > -110 || coordinates[1] < 47 || coordinates[1] > 61
  ) {
    throw new Error(`Invalid B.C. point coordinates for observation ${observationId}`)
  }

  let taxon = {}
  try {
    taxon = typeof properties.taxon === 'string' ? JSON.parse(properties.taxon) : (properties.taxon ?? {})
  } catch {
    throw new Error(`Invalid embedded taxon JSON for observation ${observationId}`)
  }

  const taxonId = cleanString(String(taxon.id ?? '')) || null
  const scientificName = cleanString(taxon.name) || 'Taxon unavailable'
  const commonName = cleanString(taxon.preferred_common_name) || null
  const display = commonName ? `${commonName} · ${scientificName}` : scientificName
  const observedOn = cleanString(properties.observed_on) || null
  const positionalAccuracy = numberOrNull(properties.public_positional_accuracy)
  const group = taxonGroup(taxon.iconic_taxon_name)
  const status = normalizeStatus(taxon.conservation_status)
  const detailLines = [
    `Observation ID: ${observationId}`,
    `Taxon: ${display}`,
    `Group: ${group}`,
    observedOn ? `Observed on: ${observedOn}` : 'Observation date unavailable',
    positionalAccuracy === null ? 'Public positional accuracy unavailable' : `Public positional accuracy: ${positionalAccuracy.toLocaleString('en-CA')} m`,
    status.name ? `Snapshot conservation status: ${status.name}${status.authority ? ` · ${status.authority}` : ''}` : 'Included by the source snapshot threat filter; no status label supplied',
    'Historical iNaturalist point; not a habitat polygon or official legal designation.',
  ]

  return {
    type: 'Feature',
    id: observationId,
    geometry: {
      type: 'Point',
      coordinates: [Number(coordinates[0].toFixed(6)), Number(coordinates[1].toFixed(6))],
    },
    properties: {
      observation_id: observationId,
      taxon_id: taxonId,
      title: commonName || scientificName,
      display,
      details: detailLines.join('\n'),
      scientific_name: scientificName,
      common_name: commonName,
      taxon_group: group,
      threatened_in_snapshot: taxon.threatened === true,
      native_in_snapshot: taxon.native === true,
      introduced_in_snapshot: taxon.introduced === true,
      extinct_in_snapshot: taxon.extinct === true,
      taxon_active_in_snapshot: taxon.is_active === true,
      observed_on: observedOn,
      observed_year: Number.isInteger(Number(observedOn?.slice(0, 4))) ? Number(observedOn.slice(0, 4)) : null,
      observation_period: observationPeriod(observedOn),
      positional_accuracy_m: positionalAccuracy,
      accuracy_band: accuracyBand(positionalAccuracy),
      conservation_status_code: status.code,
      conservation_status_name: status.name,
      conservation_status_authority: status.authority,
      observation_url: `https://www.inaturalist.org/observations/${observationId}`,
    },
  }
}

const inputDirectory = option('--input')
const snapshotDate = option('--snapshot-date')
const tileListPath = option('--tile-list')
if (!inputDirectory || !snapshotDate || !/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
  throw new Error('Usage: import-inaturalist-species-at-risk.mjs --input /path/to/archive --snapshot-date YYYY-MM-DD [--tile-list /path/to/list.txt]')
}

const inputRoot = resolve(inputDirectory)
const tileJson = JSON.parse(await readFile(join(inputRoot, 'tilejson.json'), 'utf8'))
const downloadSummary = JSON.parse(await readFile(join(inputRoot, 'download-summary.json'), 'utf8'))
const maxZoom = Number(tileJson.maxzoom)
if (!Number.isInteger(maxZoom)) throw new Error('tilejson.json must provide an integer maxzoom')

let tilePaths
if (tileListPath) {
  tilePaths = (await readFile(tileListPath, 'utf8')).split(/\r?\n/).map((path) => path.trim()).filter(Boolean)
    .map((path) => isAbsolute(path) ? resolve(path) : resolve(inputRoot, path))
  for (const path of tilePaths) {
    const rel = relative(inputRoot, path)
    if (rel.startsWith(`..${sep}`) || rel === '..') throw new Error(`Tile list path is outside the input archive: ${path}`)
    if (!(await stat(path)).isFile()) throw new Error(`Tile list entry is not a file: ${path}`)
  }
} else {
  tilePaths = await walkPbfFiles(join(inputRoot, 'tiles'))
}

tilePaths = [...new Set(tilePaths)].sort((left, right) => relative(inputRoot, left).localeCompare(relative(inputRoot, right)))
const maximumZoomTiles = tilePaths.filter((path) => parseTileCoordinates(path).z === maxZoom)
if (maximumZoomTiles.length < 10) throw new Error(`Expected at least 10 maximum-zoom tiles; found ${maximumZoomTiles.length}`)

const digest = createHash('sha256')
const observations = new Map()
let decodedFeatures = 0
for (const path of maximumZoomTiles) {
  const relativePath = relative(inputRoot, path)
  const compressed = await readFile(path)
  digest.update(relativePath).update('\0').update(compressed)
  const { z, x, y } = parseTileCoordinates(path)
  const tile = new VectorTile(new Pbf(gunzipSync(compressed)))
  const layer = tile.layers.inaturalist
  if (!layer) continue
  for (let index = 0; index < layer.length; index += 1) {
    const normalized = normalizeFeature(layer.feature(index).toGeoJSON(x, y, z))
    decodedFeatures += 1
    if (!observations.has(normalized.properties.observation_id)) observations.set(normalized.properties.observation_id, normalized)
  }
}

if (observations.size < 1000) throw new Error(`Expected at least 1,000 unique observations; found ${observations.size}`)
const taxonCounts = new Map()
for (const feature of observations.values()) {
  const key = feature.properties.taxon_id ?? feature.properties.scientific_name
  taxonCounts.set(key, (taxonCounts.get(key) ?? 0) + 1)
}
for (const feature of observations.values()) {
  const key = feature.properties.taxon_id ?? feature.properties.scientific_name
  const count = taxonCounts.get(key)
  feature.properties.taxon_observation_count = count
  feature.properties.observation_frequency_band = observationFrequencyBand(count)
}

const features = [...observations.values()].sort((left, right) => {
  const leftId = Number(left.properties.observation_id)
  const rightId = Number(right.properties.observation_id)
  if (Number.isFinite(leftId) && Number.isFinite(rightId)) return leftId - rightId
  return left.properties.observation_id.localeCompare(right.properties.observation_id)
})
const longitudes = features.map((feature) => feature.geometry.coordinates[0])
const latitudes = features.map((feature) => feature.geometry.coordinates[1])
const years = features.map((feature) => feature.properties.observed_year).filter(Number.isInteger)
const byGroup = Object.fromEntries([...new Set(features.map((feature) => feature.properties.taxon_group))].sort()
  .map((group) => [group, features.filter((feature) => feature.properties.taxon_group === group).length]))
const byAccuracyBand = Object.fromEntries([...new Set(features.map((feature) => feature.properties.accuracy_band))]
  .map((band) => [band, features.filter((feature) => feature.properties.accuracy_band === band).length]))
const topTaxa = [...taxonCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 10).map(([taxonKey, observationsCount]) => {
  const feature = features.find((candidate) => (candidate.properties.taxon_id ?? candidate.properties.scientific_name) === taxonKey)
  return { taxonId: feature.properties.taxon_id, name: feature.properties.display, observations: observationsCount }
})

const counts = {
  decodedFeatures,
  uniqueObservations: features.length,
  uniqueTaxa: taxonCounts.size,
  withObservationDate: years.length,
  observationYearRange: years.length ? [Math.min(...years), Math.max(...years)] : null,
  withAccuracy: features.filter((feature) => feature.properties.positional_accuracy_m !== null).length,
  withNamedConservationStatus: features.filter((feature) => feature.properties.conservation_status_name).length,
  byGroup,
  byAccuracyBand,
}
const output = {
  type: 'FeatureCollection',
  name: 'inaturalist_species_at_risk',
  metadata: {
    title: 'iNaturalist species-at-risk observations',
    snapshotDate,
    sourceKind: 'BC Forest Map Mapbox vector-tile mirror',
    sourceTilesetId: downloadSummary.tileset_id ?? null,
    sourceGenerator: cleanString(tileJson.generator) || null,
    sourceMaximumZoom: maxZoom,
    sourceMaximumZoomTiles: maximumZoomTiles.length,
    sourceMaximumZoomSha256: digest.digest('hex'),
    sourceMirrorBytes: numberOrNull(downloadSummary.downloaded_or_existing_bytes),
    sourceCandidateTiles: numberOrNull(downloadSummary.candidate_tiles),
    sourceStatusCounts: downloadSummary.status_counts ?? null,
    sourceBounds: tileJson.bounds ?? null,
    outputCrs: 'EPSG:4326',
    coordinatePrecision: 6,
    counts,
    topTaxa,
    bounds: [Math.min(...longitudes), Math.min(...latitudes), Math.max(...longitudes), Math.max(...latitudes)],
    note: 'Historical processed snapshot. The source Tippecanoe recipe selected threatened=true observations with public positional accuracy below 100 m. This is not an official B.C. or federal legal designation, and point density does not measure abundance, habitat, or absence.',
  },
  features,
}

const payload = `${JSON.stringify(output)}\n`
await mkdir(dirname(OUTPUT_PATH), { recursive: true })
await writeFile(OUTPUT_PATH, payload)
console.log(JSON.stringify({
  output: OUTPUT_PATH,
  ...counts,
  topTaxa,
  bytes: Buffer.byteLength(payload),
  gzipBytes: gzipSync(payload).length,
  bounds: output.metadata.bounds,
}, null, 2))
