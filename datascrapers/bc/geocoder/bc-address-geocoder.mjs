import { readFile } from 'node:fs/promises'

export const BC_ADDRESS_GEOCODER_URL = 'https://geocoder.api.gov.bc.ca/addresses.json'

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

export function normalizeBcAddress(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\b(avenue)\b/g, 'ave')
    .replace(/\b(street)\b/g, 'st')
    .replace(/\b(road)\b/g, 'rd')
    .replace(/\b(boulevard)\b/g, 'blvd')
    .replace(/\b(highway)\b/g, 'hwy')
    .replace(/\b(drive)\b/g, 'dr')
    .replace(/\b(place)\b/g, 'pl')
    .replace(/\b(crescent)\b/g, 'cres')
    .replace(/\b(north)\b/g, 'n')
    .replace(/\b(south)\b/g, 's')
    .replace(/\b(east)\b/g, 'e')
    .replace(/\b(west)\b/g, 'w')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function bcAddressQuery(address, locality = 'Prince George') {
  const trimmed = String(address ?? '').trim()
  if (!trimmed) return ''
  return `${trimmed}, ${locality}, BC`
}

export async function geocodeBcAddress(query, options = {}) {
  const params = new URLSearchParams({
    addressString: query,
    locationDescriptor: options.locationDescriptor ?? 'accessPoint',
    maxResults: String(options.maxResults ?? 1),
    minScore: String(options.minScore ?? 75),
    outputSRS: String(options.outputSRS ?? 4326),
    brief: 'false',
    echo: 'true',
  })
  const response = await fetch(`${BC_ADDRESS_GEOCODER_URL}?${params.toString()}`, {
    headers: { 'user-agent': options.userAgent ?? 'PGMaps BC address geocoder' },
  })
  if (!response.ok) throw new Error(`Failed to geocode ${query}: ${response.status}`)

  const data = await response.json()
  const feature = data.features?.[0]
  if (!feature?.geometry?.coordinates || !feature?.properties) {
    return {
      query,
      status: 'not_found',
      geocodedAt: new Date().toISOString(),
    }
  }
  return {
    query,
    status: 'matched',
    geocodedAt: new Date().toISOString(),
    geometry: {
      type: 'Point',
      coordinates: feature.geometry.coordinates,
    },
    properties: feature.properties,
  }
}

export async function geocodeBcAddressQueries(queries, options = {}) {
  const cache = await readJsonIfExists(options.cachePath, {})
  const uniqueQueries = [...new Set(queries.filter(Boolean))]
  const delayMs = Number(options.delayMs ?? 75)
  let requested = 0

  for (const query of uniqueQueries) {
    if (cache[query]) continue
    cache[query] = await geocodeBcAddress(query, options)
    requested += 1
    if (delayMs > 0) await sleep(delayMs)
  }

  return {
    cache,
    requested,
    uniqueQueryCount: uniqueQueries.length,
  }
}

export function isAcceptedBcGeocode(match, options = {}) {
  const minScore = Number(options.minScore ?? 75)
  const expectedLocality = String(options.locality ?? 'Prince George').toLowerCase()
  const score = Number(match?.properties?.score ?? 0)
  const locality = String(match?.properties?.localityName ?? '').toLowerCase()
  return match?.status === 'matched' && score >= minScore && locality === expectedLocality
}

export function bcGeocodeFeatureProperties(match) {
  return {
    geocodeQuery: match.query,
    geocodeScore: Number(match.properties.score ?? 0),
    geocodeMatchPrecision: match.properties.matchPrecision,
    geocodePrecisionPoints: match.properties.precisionPoints,
    geocodeFullAddress: match.properties.fullAddress,
    geocodeStreetAddress: match.properties.streetAddress,
    geocodeLocalityName: match.properties.localityName,
    geocodePositionalAccuracy: match.properties.locationPositionalAccuracy,
    geocodeSiteId: match.properties.siteID,
    geocodeIsOfficial: match.properties.isOfficial,
    geocodeFaults: match.properties.faults ?? [],
  }
}
