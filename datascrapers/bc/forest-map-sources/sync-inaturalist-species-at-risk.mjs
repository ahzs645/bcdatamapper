import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SUBMODULE_ROOT = join(SCRIPT_DIR, '..', '..', '..')
const OUTPUT_DIR = join(SCRIPT_DIR, 'output', 'species-at-risk')
const API_URL = 'https://api.inaturalist.org/v2/observations'
const USER_AGENT = 'PGMaps-bcdatamapper/1.0 (https://github.com/ahmadjalil/PGMaps)'
const PER_PAGE = 200
const DEFAULT_DELAY_MS = 1000
let minimumRequestIntervalMs = DEFAULT_DELAY_MS
let lastRequestStartedAt = 0
const FIELDS = [
  'id',
  'observed_on',
  'location',
  'positional_accuracy',
  'quality_grade',
  'geoprivacy',
  'license_code',
  'taxon.id',
  'taxon.name',
  'taxon.preferred_common_name',
  'taxon.iconic_taxon_name',
  'taxon.threatened',
  'taxon.native',
  'taxon.introduced',
  'taxon.extinct',
  'taxon.is_active',
  'taxon.conservation_status.status',
  'taxon.conservation_status.status_name',
  'taxon.conservation_status.authority',
  'taxon.conservation_status.place_id',
].join(',')

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function hasFlag(name) {
  return process.argv.includes(name)
}

function cleanString(value) {
  return typeof value === 'string' ? value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim() : ''
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
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
  if (year < 2022) return '2019–2021'
  if (year < 2025) return '2022–2024'
  return '2025–2026'
}

function accuracyBand(value) {
  if (value === null) return 'Accuracy unavailable'
  if (value < 10) return 'Under 10 m'
  if (value < 25) return '10–24 m'
  if (value < 50) return '25–49 m'
  return '50 m or more'
}

function observationFrequencyBand(value) {
  if (value >= 500) return '500 or more observations'
  if (value >= 100) return '100–499 observations'
  if (value >= 20) return '20–99 observations'
  return 'Under 20 observations'
}

function normalizeObservation(observation) {
  const observationId = cleanString(String(observation.id ?? ''))
  const taxon = observation.taxon ?? {}
  const location = cleanString(observation.location).split(',').map(Number)
  if (!observationId || location.length !== 2 || !location.every(Number.isFinite)) {
    throw new Error(`Observation ${observationId || '(missing ID)'} has no usable public location`)
  }
  const [latitude, longitude] = location
  if (longitude < -141 || longitude > -110 || latitude < 47 || latitude > 61) {
    throw new Error(`Observation ${observationId} is outside the expected B.C. bounds`)
  }

  const taxonId = cleanString(String(taxon.id ?? '')) || null
  const scientificName = cleanString(taxon.name) || 'Taxon unavailable'
  const commonName = cleanString(taxon.preferred_common_name) || null
  const display = commonName ? `${commonName} · ${scientificName}` : scientificName
  const observedOn = cleanString(observation.observed_on) || null
  const positionalAccuracy = numberOrNull(observation.positional_accuracy)
  const group = taxonGroup(taxon.iconic_taxon_name)
  const status = taxon.conservation_status ?? {}

  return {
    type: 'Feature',
    id: observationId,
    geometry: {
      type: 'Point',
      coordinates: [Number(longitude.toFixed(6)), Number(latitude.toFixed(6))],
    },
    properties: {
      observation_id: observationId,
      taxon_id: taxonId,
      title: commonName || scientificName,
      display,
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
      conservation_status_code: cleanString(status.status) || null,
      conservation_status_name: cleanString(status.status_name) || null,
      conservation_status_authority: cleanString(status.authority) || null,
      quality_grade: cleanString(observation.quality_grade) || null,
      geoprivacy: cleanString(observation.geoprivacy) || null,
      license_code: cleanString(observation.license_code) || null,
      observation_url: `https://www.inaturalist.org/observations/${observationId}`,
    },
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function fetchJson(url, attempt = 1) {
  const waitBeforeRequest = Math.max(0, minimumRequestIntervalMs - (Date.now() - lastRequestStartedAt))
  if (waitBeforeRequest > 0) await wait(waitBeforeRequest)
  lastRequestStartedAt = Date.now()
  let response
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(45_000),
    })
  } catch (error) {
    if (attempt >= 6) throw error
    const delay = Math.min(30_000, 1000 * (2 ** (attempt - 1)))
    console.warn(`[iNaturalist] request failed; retrying in ${delay} ms (${error.message})`)
    await wait(delay)
    return fetchJson(url, attempt + 1)
  }

  if (!response.ok) {
    if (attempt >= 6 || (response.status < 500 && response.status !== 429)) {
      throw new Error(`iNaturalist API returned HTTP ${response.status}: ${await response.text()}`)
    }
    const retryAfter = Number(response.headers.get('retry-after'))
    const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(30_000, 1000 * (2 ** (attempt - 1)))
    console.warn(`[iNaturalist] HTTP ${response.status}; retrying in ${delay} ms`)
    await wait(delay)
    return fetchJson(url, attempt + 1)
  }

  return response.json()
}

function buildUrl(snapshotDate, idAbove) {
  const url = new URL(API_URL)
  const query = {
    place_id: '7085',
    quality_grade: 'research',
    acc_below: '50',
    threatened: 'true',
    taxon_geoprivacy: 'open',
    hrank: 'genus',
    created_d2: snapshotDate,
    d2: snapshotDate,
    per_page: String(PER_PAGE),
    order_by: 'id',
    order: 'asc',
    fields: FIELDS,
  }
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  if (idAbove) url.searchParams.set('id_above', idAbove)
  return url
}

function summarize(features) {
  const taxonCounts = new Map()
  const taxonNames = new Map()
  for (const feature of features) {
    const key = feature.properties.taxon_id ?? feature.properties.scientific_name
    taxonCounts.set(key, (taxonCounts.get(key) ?? 0) + 1)
    taxonNames.set(key, feature.properties.display)
  }
  for (const feature of features) {
    const key = feature.properties.taxon_id ?? feature.properties.scientific_name
    const count = taxonCounts.get(key)
    feature.properties.taxon_observation_count = count
    feature.properties.observation_frequency_band = observationFrequencyBand(count)
  }

  const countBy = (property) => Object.fromEntries([...new Set(features.map((feature) => feature.properties[property]))].sort()
    .map((value) => [value, features.filter((feature) => feature.properties[property] === value).length]))
  const years = features.map((feature) => feature.properties.observed_year).filter(Number.isInteger)
  const topTaxa = [...taxonCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 20)
    .map(([taxonId, observations]) => ({ taxonId: String(taxonId), name: taxonNames.get(taxonId), observations }))
  return {
    counts: {
      observations: features.length,
      uniqueTaxa: taxonCounts.size,
      withObservationDate: years.length,
      observationYearRange: years.length ? [Math.min(...years), Math.max(...years)] : null,
      withAccuracy: features.filter((feature) => feature.properties.positional_accuracy_m !== null).length,
      withNamedConservationStatus: features.filter((feature) => feature.properties.conservation_status_name).length,
      byGroup: countBy('taxon_group'),
      byObservationPeriod: countBy('observation_period'),
      byAccuracyBand: countBy('accuracy_band'),
      byLicense: countBy('license_code'),
    },
    topTaxa,
  }
}

const snapshotDate = option('--snapshot-date')
const delayMs = Number(option('--delay-ms') ?? DEFAULT_DELAY_MS)
const resume = hasFlag('--resume')
const restart = hasFlag('--restart')
if (!snapshotDate || !/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate) || !Number.isFinite(delayMs) || delayMs < 1000) {
  throw new Error('Usage: sync-inaturalist-species-at-risk.mjs --snapshot-date YYYY-MM-DD [--resume|--restart] [--delay-ms >=1000]')
}
if (resume && restart) throw new Error('Choose either --resume or --restart, not both')
minimumRequestIntervalMs = delayMs

const stem = `inaturalist_species_at_risk_live_${snapshotDate}`
const checkpointPath = join(SUBMODULE_ROOT, 'tmp', `${stem}.ndjson`)
const checkpointMetaPath = join(SUBMODULE_ROOT, 'tmp', `${stem}.checkpoint.json`)
const outputPath = join(OUTPUT_DIR, `${stem}.geojson.gz`)
const manifestPath = join(OUTPUT_DIR, `${stem}.manifest.json`)
const latestPath = join(OUTPUT_DIR, 'inaturalist_species_at_risk_live_latest.json')
await mkdir(dirname(checkpointPath), { recursive: true })
await mkdir(OUTPUT_DIR, { recursive: true })

let features = []
let lastId = null
let requestCount = 0
let reportedTotal = null
if (resume) {
  const meta = JSON.parse(await readFile(checkpointMetaPath, 'utf8'))
  if (meta.snapshotDate !== snapshotDate || meta.apiUrl !== API_URL) throw new Error('Checkpoint query does not match this sync')
  const checkpoint = await readFile(checkpointPath, 'utf8')
  features = checkpoint.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  lastId = features.at(-1)?.properties.observation_id ?? null
  requestCount = meta.requestCount ?? 0
  reportedTotal = numberOrNull(meta.reportedTotal)
  console.log(`[iNaturalist] resumed ${features.length.toLocaleString('en-CA')} observations after ID ${lastId}`)
} else {
  try {
    await readFile(checkpointPath, 'utf8')
    if (!restart) throw new Error(`Checkpoint exists at ${checkpointPath}; use --resume or --restart`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await writeFile(checkpointPath, '')
  await writeFile(checkpointMetaPath, `${JSON.stringify({ snapshotDate, apiUrl: API_URL, requestCount: 0 }, null, 2)}\n`)
}

let page = await fetchJson(buildUrl(snapshotDate, lastId))
if (reportedTotal === null) reportedTotal = numberOrNull(page.total_results)
while (true) {
  requestCount += 1
  const results = Array.isArray(page.results) ? page.results : []
  if (results.length === 0) break
  const normalized = results.map(normalizeObservation)
  for (const feature of normalized) {
    const id = Number(feature.properties.observation_id)
    if (lastId !== null && id <= Number(lastId)) throw new Error(`API cursor did not advance beyond observation ${lastId}`)
    lastId = feature.properties.observation_id
  }
  features.push(...normalized)
  await appendFile(checkpointPath, `${normalized.map((feature) => JSON.stringify(feature)).join('\n')}\n`)
  await writeFile(checkpointMetaPath, `${JSON.stringify({ snapshotDate, apiUrl: API_URL, requestCount, reportedTotal, lastId, observations: features.length }, null, 2)}\n`)

  if (requestCount === 1 || requestCount % 10 === 0 || results.length < PER_PAGE) {
    const expected = reportedTotal === null ? '' : ` of about ${reportedTotal.toLocaleString('en-CA')}`
    console.log(`[iNaturalist] ${features.length.toLocaleString('en-CA')}${expected} observations · ${requestCount} requests · last ID ${lastId}`)
  }
  if (results.length < PER_PAGE) break
  page = await fetchJson(buildUrl(snapshotDate, lastId))
}

features.sort((left, right) => Number(left.properties.observation_id) - Number(right.properties.observation_id))
const ids = features.map((feature) => feature.properties.observation_id)
if (new Set(ids).size !== ids.length) throw new Error('Live snapshot contains duplicate observation IDs')
const { counts, topTaxa } = summarize(features)
const longitudes = features.map((feature) => feature.geometry.coordinates[0])
const latitudes = features.map((feature) => feature.geometry.coordinates[1])
const output = {
  type: 'FeatureCollection',
  name: stem,
  metadata: {
    title: 'Live iNaturalist species-at-risk observations in British Columbia',
    snapshotDate,
    sourceKind: 'Supported iNaturalist observations API v2',
    sourceApiUrl: API_URL,
    sourcePlace: { id: 7085, name: 'British Columbia, CA' },
    sourceQuery: Object.fromEntries(buildUrl(snapshotDate, null).searchParams.entries()),
    requestCount,
    reportedTotalAtStart: reportedTotal,
    outputCrs: 'EPSG:4326',
    coordinatePrecision: 6,
    counts,
    topTaxa,
    bounds: [Math.min(...longitudes), Math.min(...latitudes), Math.max(...longitudes), Math.max(...latitudes)],
    note: 'Dated live API snapshot. Taxa were selected by the iNaturalist threatened flag; this is not an official B.C. or federal legal designation. Observation density does not measure abundance, habitat, or absence.',
  },
  features,
}
const payload = `${JSON.stringify(output)}\n`
const compressed = gzipSync(payload, { level: 9, mtime: 0 })
const sha256 = createHash('sha256').update(compressed).digest('hex')
const manifest = {
  version: 1,
  snapshotDate,
  file: `${stem}.geojson.gz`,
  sha256,
  bytes: compressed.length,
  uncompressedBytes: Buffer.byteLength(payload),
  counts,
  topTaxa,
  source: {
    apiUrl: API_URL,
    placeId: 7085,
    placeName: 'British Columbia, CA',
    query: output.metadata.sourceQuery,
    reportedTotalAtStart: reportedTotal,
    requests: requestCount,
  },
  note: output.metadata.note,
}
await writeFile(outputPath, compressed)
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(latestPath, `${JSON.stringify({ snapshotDate, manifest: `${stem}.manifest.json`, file: `${stem}.geojson.gz`, sha256 }, null, 2)}\n`)
await rm(checkpointPath)
await rm(checkpointMetaPath)
console.log(JSON.stringify({ output: outputPath, manifest: manifestPath, ...manifest }, null, 2))
