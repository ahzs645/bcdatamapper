import { readFile } from 'node:fs/promises'

export const BC_ADDRESS_GEOCODER_URL = 'https://geocoder.api.gov.bc.ca/addresses.json'
export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

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

export function normalizePlaceName(value, options = {}) {
  const stopWords = options.stopWords ?? ['ltd', 'limited', 'inc', 'corp', 'corporation', 'co', 'company', 'the']
  const escapedStopWords = stopWords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`\\b(${escapedStopWords.join('|')})\\b`, 'g')
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(pattern, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export async function fetchOverpassElements(query, options = {}) {
  const response = await fetch(options.url ?? OVERPASS_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': options.userAgent ?? 'PGMaps bcdatamapper location utility',
    },
    body: new URLSearchParams({ data: query }),
  })
  if (!response.ok) throw new Error(`Failed to fetch ${options.url ?? OVERPASS_URL}: ${response.status}`)
  const data = await response.json()
  return data.elements ?? []
}

export function osmAddressText(tags = {}) {
  if (tags['addr:full']) return tags['addr:full']
  return [tags['addr:unit'], tags['addr:housenumber'], tags['addr:street']]
    .filter((part) => part != null && part !== '')
    .join(' ')
}

export function overpassElementPoint(element) {
  const latitude = element.lat ?? element.center?.lat
  const longitude = element.lon ?? element.center?.lon
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  return { latitude, longitude }
}

export function findRecordsByName(recordIndex, name, options = {}) {
  const normalized = normalizePlaceName(name, options)
  if (!normalized) return []
  const exact = recordIndex.get(normalized) ?? []
  if (exact.length) return exact

  const tokens = normalized.split('-').filter((token) => token.length > 2)
  if (!tokens.length) return []
  const candidates = []
  for (const [key, records] of recordIndex) {
    const keyTokens = key.split('-')
    const overlap = tokens.filter((token) => keyTokens.includes(token)).length
    if (overlap >= Math.min(2, tokens.length)) candidates.push(...records)
  }
  return candidates.slice(0, options.limit ?? 5)
}

export function indexRecordsByName(records, getName, options = {}) {
  const index = new Map()
  for (const record of records) {
    const key = normalizePlaceName(getName(record), options)
    if (!key) continue
    index.set(key, [...(index.get(key) ?? []), record])
  }
  return index
}

export function matchRecordsToPointFeatures(records, features, options = {}) {
  const getRecordId = options.getRecordId ?? ((record) => record.id)
  const getRecordName = options.getRecordName ?? ((record) => record.name)
  const getRecordAddress = options.getRecordAddress ?? ((record) => record.address)
  const getFeatureId = options.getFeatureId ?? ((feature) => feature.properties.id)
  const getFeatureName = options.getFeatureName ?? ((feature) => feature.properties.name)
  const getFeatureAddress = options.getFeatureAddress ?? ((feature) => feature.properties.address)
  const normalizeName = options.normalizeName ?? normalizePlaceName
  const normalizeAddress = options.normalizeAddress ?? normalizeBcAddress
  const buildProperties = options.buildProperties ?? ((record) => record)

  const featuresByName = new Map()
  const featuresByAddress = new Map()

  for (const feature of features) {
    const nameKey = normalizeName(getFeatureName(feature))
    const addressKey = normalizeAddress(getFeatureAddress(feature))
    if (nameKey) featuresByName.set(nameKey, [...(featuresByName.get(nameKey) ?? []), feature])
    if (addressKey) featuresByAddress.set(addressKey, [...(featuresByAddress.get(addressKey) ?? []), feature])
  }

  const matchedFeatures = []
  const matchedRecordIds = new Set()

  for (const record of records) {
    const recordId = getRecordId(record)
    const nameKey = normalizeName(getRecordName(record))
    const addressKey = normalizeAddress(getRecordAddress(record))
    const nameMatches = nameKey ? featuresByName.get(nameKey) ?? [] : []
    const addressMatches = addressKey ? featuresByAddress.get(addressKey) ?? [] : []
    const candidates = new Map()

    for (const feature of nameMatches) {
      candidates.set(getFeatureId(feature), {
        feature,
        matchMethod: 'exact_name',
        locationConfidence: 'medium',
        score: 75,
      })
    }

    for (const feature of addressMatches) {
      const existing = candidates.get(getFeatureId(feature))
      candidates.set(getFeatureId(feature), {
        feature,
        matchMethod: existing ? 'exact_name_and_address' : 'exact_address',
        locationConfidence: existing ? 'high' : 'medium',
        score: existing ? 100 : 85,
      })
    }

    const best = [...candidates.values()].sort((a, b) => b.score - a.score)[0]
    if (!best || matchedRecordIds.has(recordId)) continue

    matchedRecordIds.add(recordId)
    matchedFeatures.push({
      type: 'Feature',
      geometry: best.feature.geometry,
      properties: buildProperties(record, best),
    })
  }

  return {
    type: 'FeatureCollection',
    features: matchedFeatures,
  }
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

export async function buildBcGeocodedPointCollection(records, options = {}) {
  const getAddress = options.getAddress ?? ((record) => record.address)
  const buildProperties = options.buildProperties ?? ((record) => record)
  const minScore = Number(options.minScore ?? 75)
  const uniqueQueries = [
    ...new Set(records.map((record) => bcAddressQuery(getAddress(record), options.locality)).filter(Boolean)),
  ]
  const geocoded = await geocodeBcAddressQueries(uniqueQueries, {
    cachePath: options.cachePath,
    delayMs: options.delayMs,
    minScore,
    locality: options.locality,
  })

  const features = []
  for (const record of records) {
    const query = bcAddressQuery(getAddress(record), options.locality)
    const match = geocoded.cache[query]
    if (!isAcceptedBcGeocode(match, { minScore, locality: options.locality })) continue
    features.push({
      type: 'Feature',
      geometry: match.geometry,
      properties: {
        ...buildProperties(record, match),
        ...bcGeocodeFeatureProperties(match),
      },
    })
  }

  return {
    cache: geocoded.cache,
    requested: geocoded.requested,
    uniqueQueryCount: geocoded.uniqueQueryCount,
    collection: {
      type: 'FeatureCollection',
      features,
    },
  }
}
