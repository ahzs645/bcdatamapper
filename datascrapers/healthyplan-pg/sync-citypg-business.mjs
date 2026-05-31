import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { countBy, fetchJson, OUTPUT_ROOT, slug, writeJson } from './lib/shared.mjs'

export const CITYPG_BUSINESS_LAYER =
  'https://services2.arcgis.com/CnkB6jCzAsyli34z/arcgis/rest/services/Business_License/FeatureServer/0'

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
const BC_GEOCODER_URL = 'https://geocoder.api.gov.bc.ca/addresses.json'
const BC_GEOCODER_CACHE = `${OUTPUT_ROOT}/business_bc_geocode_cache.json`
const BC_GEOCODER_DELAY_MS = Number(process.env.BC_GEOCODER_DELAY_MS ?? 75)
const BC_GEOCODER_MIN_SCORE = Number(process.env.BC_GEOCODER_MIN_SCORE ?? 75)

const OSM_POI_QUERY = `[out:json][timeout:45];
area["name"="Prince George"]["boundary"="administrative"]->.a;
(
  nwr(area.a)[shop];
  nwr(area.a)[amenity~"^(restaurant|cafe|fast_food|bank|pharmacy|post_office|library|fuel|marketplace|clinic|dentist|doctors|pub|bar)$"];
  nwr(area.a)[office];
  nwr(area.a)[craft];
);
out tags center qt;`

async function fetchBusinessLicences() {
  const all = []
  let offset = 0
  const pageSize = 1000

  while (true) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: 'LicenceNumber,DateFrom,DateTo,TradeName,LicenceDesc,LicenceCategory,Unit,Address,StreeName',
      returnGeometry: 'false',
      f: 'json',
      resultRecordCount: String(pageSize),
      resultOffset: String(offset),
    })
    const data = await fetchJson(`${CITYPG_BUSINESS_LAYER}/query?${params.toString()}`)
    const features = data.features ?? []
    all.push(...features.map((feature) => feature.attributes ?? {}))
    if (features.length < pageSize) break
    offset += features.length
  }

  return all
}

async function fetchOsmPois() {
  const body = new URLSearchParams({ data: OSM_POI_QUERY })
  const data = await fetchJson(OVERPASS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  return data.elements ?? []
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function normalizeBusinessName(value) {
  return slug(value)
    .replace(/\b(ltd|limited|inc|corp|corporation|co|company|the|canada|bc|b-c)\b/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function normalizeAddress(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\b(avenue)\b/g, 'ave')
    .replace(/\b(street)\b/g, 'st')
    .replace(/\b(road)\b/g, 'rd')
    .replace(/\b(boulevard)\b/g, 'blvd')
    .replace(/\b(highway)\b/g, 'hwy')
    .replace(/\b(north)\b/g, 'n')
    .replace(/\b(south)\b/g, 's')
    .replace(/\b(east)\b/g, 'e')
    .replace(/\b(west)\b/g, 'w')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function osmAddressText(tags) {
  if (tags['addr:full']) return tags['addr:full']
  return [tags['addr:unit'], tags['addr:housenumber'], tags['addr:street']]
    .filter((part) => part != null && part !== '')
    .join(' ')
}

function classifyBusiness(row) {
  const text = `${row.TradeName ?? ''} ${row.LicenceDesc ?? ''} ${row.LicenceCategory ?? ''}`.toLowerCase()
  const category = String(row.LicenceCategory ?? '').toLowerCase()
  const desc = String(row.LicenceDesc ?? '').toLowerCase()

  if (/\bout of town\b|home business/.test(category)) {
    return { category: 'excluded_non_access_poi', healthyFood: false, retailServices: false, confidence: 'low' }
  }

  if (/\b(grocery|supermarket|farmers? market|produce|greengrocer|health food|food market)\b/.test(text)) {
    return { category: 'healthy_food_outlet', healthyFood: true, retailServices: true, confidence: 'medium' }
  }

  if (/\b(convenience store|pharmacy|retail|restaurant|coffee|cafe|deli|bank|financial|salon|barber|laund|library|medical|dental|travel agency|hotel|motel)\b/.test(text)) {
    return { category: 'retail_service', healthyFood: false, retailServices: true, confidence: 'medium' }
  }

  if (/commercial retail|commercial service|banks and other financial|restaurant/.test(category)) {
    return { category: 'retail_service_candidate', healthyFood: false, retailServices: true, confidence: 'low' }
  }

  if (/warehouse|wholesale|manufacturing|contractor|transportation depot|truck|rail terminal|industrial|storage/.test(desc) || /warehousing|wholesale|manufacturing|contractor/.test(category)) {
    return { category: 'excluded_industrial_business', healthyFood: false, retailServices: false, confidence: 'medium' }
  }

  return { category: 'unclassified_business', healthyFood: false, retailServices: false, confidence: 'low' }
}

function classifyOsm(tags) {
  const shop = tags.shop
  const amenity = tags.amenity
  const office = tags.office
  const craft = tags.craft

  if (['supermarket', 'greengrocer', 'health_food'].includes(shop) || amenity === 'marketplace') {
    return { category: 'healthy_food_outlet', healthyFood: true, retailServices: true, confidence: 'high' }
  }
  if (['convenience', 'bakery', 'butcher', 'seafood', 'deli', 'department_store'].includes(shop)) {
    return { category: 'food_or_household_retail', healthyFood: false, retailServices: true, confidence: 'high' }
  }
  if (shop || craft || office || ['restaurant', 'cafe', 'fast_food', 'bank', 'pharmacy', 'post_office', 'library', 'fuel', 'clinic', 'dentist', 'doctors', 'pub', 'bar'].includes(amenity)) {
    return { category: 'retail_service', healthyFood: false, retailServices: true, confidence: 'high' }
  }
  return { category: 'unclassified_osm_poi', healthyFood: false, retailServices: false, confidence: 'low' }
}

function addressText(row) {
  return [row.Unit, row.Address, row.StreeName].filter((part) => part != null && part !== '').join(' ')
}

function findBusinessMatches(osmFeature, businessRowsByName) {
  const normalized = normalizeBusinessName(osmFeature.properties.name)
  if (!normalized) return []
  const exact = businessRowsByName.get(normalized) ?? []
  if (exact.length) return exact

  const tokens = normalized.split('-').filter((token) => token.length > 2)
  if (!tokens.length) return []
  const candidates = []
  for (const [key, rows] of businessRowsByName) {
    const keyTokens = key.split('-')
    const overlap = tokens.filter((token) => keyTokens.includes(token)).length
    if (overlap >= Math.min(2, tokens.length)) candidates.push(...rows)
  }
  return candidates.slice(0, 5)
}

function buildOsmFeature(element, index, businessRowsByName) {
  const tags = element.tags ?? {}
  const latitude = element.lat ?? element.center?.lat
  const longitude = element.lon ?? element.center?.lon
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null

  const classification = classifyOsm(tags)
  const properties = {
    id: `osm-${element.type}-${element.id}`,
    source: 'openstreetmap_overpass',
    name: tags.name ?? `${tags.shop ?? tags.amenity ?? tags.office ?? tags.craft ?? 'POI'} ${index + 1}`,
    address: osmAddressText(tags),
    category: classification.category,
    healthyFoodOutlet: classification.healthyFood,
    retailService: classification.retailServices,
    classificationConfidence: classification.confidence,
    osmType: element.type,
    osmId: element.id,
    osmTags: tags,
  }
  const feature = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [longitude, latitude] },
    properties,
  }
  const cityMatches = findBusinessMatches(feature, businessRowsByName)
  if (cityMatches.length) {
    feature.properties.citypgBusinessMatches = cityMatches.map((row) => ({
      licenceNumber: row.LicenceNumber,
      tradeName: row.TradeName,
      licenceDescription: row.LicenceDesc,
      licenceCategory: row.LicenceCategory,
      address: addressText(row),
      classification: classifyBusiness(row),
    }))
  }
  return feature
}

function buildBusinessCandidate(row, index) {
  const classification = classifyBusiness(row)
  return {
    id: `citypg-business-${row.LicenceNumber || index}`,
    source: 'citypg_business_licence',
    name: row.TradeName,
    address: addressText(row),
    licenceNumber: row.LicenceNumber,
    licenceDescription: row.LicenceDesc,
    licenceCategory: row.LicenceCategory,
    dateFrom: row.DateFrom,
    dateTo: row.DateTo,
    ...classification,
  }
}

function buildOsmLocationMatches(businessCandidates, osmFeatures) {
  const osmByName = new Map()
  const osmByAddress = new Map()

  for (const feature of osmFeatures) {
    const nameKey = normalizeBusinessName(feature.properties.name)
    const addressKey = normalizeAddress(feature.properties.address)
    if (nameKey) osmByName.set(nameKey, [...(osmByName.get(nameKey) ?? []), feature])
    if (addressKey) osmByAddress.set(addressKey, [...(osmByAddress.get(addressKey) ?? []), feature])
  }

  const matchedFeatures = []
  const matchedLicenceNumbers = new Set()

  for (const business of businessCandidates) {
    const nameKey = normalizeBusinessName(business.name)
    const addressKey = normalizeAddress(business.address)
    const nameMatches = nameKey ? osmByName.get(nameKey) ?? [] : []
    const addressMatches = addressKey ? osmByAddress.get(addressKey) ?? [] : []
    const candidates = new Map()

    for (const feature of nameMatches) {
      candidates.set(feature.properties.id, {
        feature,
        matchMethod: 'exact_name',
        locationConfidence: 'medium',
        score: 75,
      })
    }

    for (const feature of addressMatches) {
      const existing = candidates.get(feature.properties.id)
      candidates.set(feature.properties.id, {
        feature,
        matchMethod: existing ? 'exact_name_and_address' : 'exact_address',
        locationConfidence: existing ? 'high' : 'medium',
        score: existing ? 100 : 85,
      })
    }

    const best = [...candidates.values()].sort((a, b) => b.score - a.score)[0]
    if (!best || matchedLicenceNumbers.has(business.licenceNumber)) continue

    matchedLicenceNumbers.add(business.licenceNumber)
    matchedFeatures.push({
      type: 'Feature',
      geometry: best.feature.geometry,
      properties: {
        ...business,
        locationSource: 'openstreetmap_overpass',
        locationConfidence: best.locationConfidence,
        locationMatchMethod: best.matchMethod,
        matchedOsmId: best.feature.properties.osmId,
        matchedOsmType: best.feature.properties.osmType,
        matchedOsmName: best.feature.properties.name,
        matchedOsmAddress: best.feature.properties.address,
        matchedOsmTags: best.feature.properties.osmTags,
      },
    })
  }

  return {
    type: 'FeatureCollection',
    features: matchedFeatures,
  }
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

function geocoderQueryForBusiness(business) {
  const address = String(business.address ?? '').trim()
  if (!address) return ''
  return `${address}, Prince George, BC`
}

async function geocodeWithBcAddressGeocoder(query) {
  const params = new URLSearchParams({
    addressString: query,
    locationDescriptor: 'accessPoint',
    maxResults: '1',
    minScore: String(BC_GEOCODER_MIN_SCORE),
    outputSRS: '4326',
    brief: 'false',
    echo: 'true',
  })
  const data = await fetchJson(`${BC_GEOCODER_URL}?${params.toString()}`)
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

async function buildBcGeocodedLocations(businessCandidates) {
  const cache = await readJsonIfExists(BC_GEOCODER_CACHE, {})
  const uniqueQueries = [...new Set(businessCandidates.map(geocoderQueryForBusiness).filter(Boolean))]
  let requested = 0

  for (const query of uniqueQueries) {
    if (cache[query]) continue
    cache[query] = await geocodeWithBcAddressGeocoder(query)
    requested += 1
    if (BC_GEOCODER_DELAY_MS > 0) await sleep(BC_GEOCODER_DELAY_MS)
  }

  const features = []
  for (const business of businessCandidates) {
    const query = geocoderQueryForBusiness(business)
    const match = cache[query]
    const score = Number(match?.properties?.score ?? 0)
    const locality = String(match?.properties?.localityName ?? '').toLowerCase()
    if (match?.status !== 'matched' || score < BC_GEOCODER_MIN_SCORE || locality !== 'prince george') continue
    features.push({
      type: 'Feature',
      geometry: match.geometry,
      properties: {
        ...business,
        locationSource: 'bc_address_geocoder',
        locationConfidence: score >= 95 ? 'high' : 'medium',
        locationMatchMethod: 'address_geocode',
        geocodeQuery: query,
        geocodeScore: score,
        geocodeMatchPrecision: match.properties.matchPrecision,
        geocodePrecisionPoints: match.properties.precisionPoints,
        geocodeFullAddress: match.properties.fullAddress,
        geocodeStreetAddress: match.properties.streetAddress,
        geocodeLocalityName: match.properties.localityName,
        geocodePositionalAccuracy: match.properties.locationPositionalAccuracy,
        geocodeSiteId: match.properties.siteID,
        geocodeIsOfficial: match.properties.isOfficial,
        geocodeFaults: match.properties.faults ?? [],
      },
    })
  }

  return {
    cache,
    requested,
    uniqueQueryCount: uniqueQueries.length,
    collection: {
      type: 'FeatureCollection',
      features,
    },
  }
}

export async function buildBusinessPois() {
  const businessRows = await fetchBusinessLicences()
  const osmElements = await fetchOsmPois()
  const businessRowsByName = new Map()
  const businessCandidates = businessRows.map(buildBusinessCandidate)

  for (const row of businessRows) {
    const key = normalizeBusinessName(row.TradeName)
    if (!key) continue
    businessRowsByName.set(key, [...(businessRowsByName.get(key) ?? []), row])
  }

  const features = osmElements
    .map((element, index) => buildOsmFeature(element, index, businessRowsByName))
    .filter(Boolean)
  const businessOsmLocations = buildOsmLocationMatches(businessCandidates, features)
  const businessBcGeocodedLocations = await buildBcGeocodedLocations(businessCandidates)

  const matchedLicenceNumbers = new Set(
    features.flatMap((feature) =>
      (feature.properties.citypgBusinessMatches ?? []).map((match) => match.licenceNumber).filter(Boolean),
    ),
  )
  const usefulBusinessCandidates = businessCandidates.filter(
    (candidate) =>
      candidate.healthyFood ||
      candidate.retailServices ||
      ['healthy_food_outlet', 'retail_service', 'retail_service_candidate', 'food_or_household_retail'].includes(
        candidate.category,
      ),
  )

  return {
    collection: {
      type: 'FeatureCollection',
      features,
    },
    businessLicencesAll: businessCandidates,
    businessCandidates: usefulBusinessCandidates,
    businessOsmLocations,
    businessBcGeocodedLocations,
    sourceStats: {
      citypgBusinessLicence: {
        url: CITYPG_BUSINESS_LAYER,
        totalRows: businessRows.length,
        usefulCandidateRows: usefulBusinessCandidates.length,
        matchedToOsmByName: matchedLicenceNumbers.size,
        locatedByOsmNameOrAddress: businessOsmLocations.features.length,
        locatedByBcAddressGeocoder: businessBcGeocodedLocations.collection.features.length,
      },
      openStreetMapOverpass: {
        url: OVERPASS_URL,
        totalElements: osmElements.length,
        mappedPointFeatures: features.length,
      },
      bcAddressGeocoder: {
        url: BC_GEOCODER_URL,
        uniqueAddressQueries: businessBcGeocodedLocations.uniqueQueryCount,
        newRequestsThisRun: businessBcGeocodedLocations.requested,
        minScore: BC_GEOCODER_MIN_SCORE,
        delayMs: BC_GEOCODER_DELAY_MS,
      },
    },
  }
}

export async function syncCityPgBusiness() {
  const business = await buildBusinessPois()
  await writeJson(`${OUTPUT_ROOT}/business_pois.geojson`, business.collection)
  await writeJson(`${OUTPUT_ROOT}/business_licences_osm_locations.geojson`, business.businessOsmLocations)
  await writeJson(
    `${OUTPUT_ROOT}/business_licences_bc_geocoded.geojson`,
    business.businessBcGeocodedLocations.collection,
  )
  await writeJson(BC_GEOCODER_CACHE, business.businessBcGeocodedLocations.cache)
  await writeJson(`${OUTPUT_ROOT}/business_licences_all.json`, business.businessLicencesAll)
  await writeJson(`${OUTPUT_ROOT}/business_candidates.json`, business.businessCandidates)
  await writeJson(`${OUTPUT_ROOT}/business_manifest.json`, {
    generatedAt: new Date().toISOString(),
    coverage: 'Prince George, BC',
    outputs: {
      businessPois: '/data/healthyplan-pg/business_pois.geojson',
      businessLicencesOsmLocations: '/data/healthyplan-pg/business_licences_osm_locations.geojson',
      businessLicencesBcGeocoded: '/data/healthyplan-pg/business_licences_bc_geocoded.geojson',
      businessLicencesAll: '/data/healthyplan-pg/business_licences_all.json',
      businessCandidates: '/data/healthyplan-pg/business_candidates.json',
    },
    businessPois: {
      ...business.sourceStats,
      featureCount: business.collection.features.length,
      categoryCounts: countBy(business.collection.features, (feature) => feature.properties.category),
      healthyFoodOutletCount: business.collection.features.filter((feature) => feature.properties.healthyFoodOutlet)
        .length,
      retailServiceCount: business.collection.features.filter((feature) => feature.properties.retailService).length,
      note: 'OSM supplies point geometry/class tags. CityPG business licences supply authoritative local inventory and are bridged by normalized name where possible. All CityPG rows are preserved in business_licences_all.json; likely HealthyPlan-relevant rows are also copied to business_candidates.json for geocoding/audit.',
    },
    licenses: [
      {
        source: 'City of Prince George Business License',
        license: 'City of Prince George Open Government Licence / source item terms',
      },
      {
        source: 'OpenStreetMap Overpass',
        license: 'Open Database Licence; attribution and derivative-database handling required',
      },
      {
        source: 'BC Address Geocoder',
        license: 'Open Government Licence - British Columbia',
      },
    ],
  })
  console.log(`Business POIs: ${business.collection.features.length}`)
  console.log(`CityPG business licences: ${business.businessLicencesAll.length}`)
  console.log(`CityPG business licences located by OSM: ${business.businessOsmLocations.features.length}`)
  console.log(
    `CityPG business licences located by BC Address Geocoder: ${business.businessBcGeocodedLocations.collection.features.length}`,
  )
  console.log(`BC Address Geocoder new requests: ${business.businessBcGeocodedLocations.requested}`)
  console.log(`Business candidates: ${business.businessCandidates.length}`)
  return business
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncCityPgBusiness().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
