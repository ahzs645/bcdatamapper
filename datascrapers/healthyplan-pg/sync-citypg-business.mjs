import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  BC_ADDRESS_GEOCODER_URL,
  buildBcGeocodedPointCollection,
  fetchOverpassElements,
  findRecordsByName,
  indexRecordsByName,
  matchRecordsToPointFeatures,
  normalizePlaceName,
  osmAddressText,
  OVERPASS_URL,
  overpassElementPoint,
} from '../bc/geocoder/bc-address-geocoder.mjs'
import { countBy, OUTPUT_ROOT, writeJson } from './lib/shared.mjs'

export const CITYPG_BUSINESS_LAYER =
  'https://services2.arcgis.com/CnkB6jCzAsyli34z/arcgis/rest/services/Business_License/FeatureServer/0'

const HEALTHYPLAN_DIR = path.dirname(fileURLToPath(import.meta.url))
const BCDATAMAPPER_ROOT = path.join(HEALTHYPLAN_DIR, '..', '..')
const CITYPG_BUSINESS_LICENCES_PATH =
  process.env.CITYPG_BUSINESS_LICENCES_PATH ??
  path.join(HEALTHYPLAN_DIR, '..', 'citypg', 'source', 'business-licences', 'business_licences_detailed.json')
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

function sourcePath(filePath) {
  return path.relative(BCDATAMAPPER_ROOT, filePath).split(path.sep).join('/')
}

async function loadBusinessLicences() {
  try {
    return JSON.parse(await readFile(CITYPG_BUSINESS_LICENCES_PATH, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    throw new Error(
      `Missing CityPG detailed business licence snapshot at ${CITYPG_BUSINESS_LICENCES_PATH}. Run npm --prefix vendor/bcdatamapper run citypg:business-licences:sync first.`,
    )
  }
}

async function fetchOsmPois() {
  return fetchOverpassElements(OSM_POI_QUERY)
}

function normalizeBusinessName(value) {
  return normalizePlaceName(value, {
    stopWords: ['ltd', 'limited', 'inc', 'corp', 'corporation', 'co', 'company', 'the', 'canada', 'bc', 'b-c'],
  })
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
  return findRecordsByName(businessRowsByName, osmFeature.properties.name, {
    stopWords: ['ltd', 'limited', 'inc', 'corp', 'corporation', 'co', 'company', 'the', 'canada', 'bc', 'b-c'],
  })
}

function buildOsmFeature(element, index, businessRowsByName) {
  const tags = element.tags ?? {}
  const point = overpassElementPoint(element)
  if (!point) return null

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
    geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
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
  return matchRecordsToPointFeatures(businessCandidates, osmFeatures, {
    getRecordId: (business) => business.licenceNumber,
    normalizeName: normalizeBusinessName,
    buildProperties: (business, best) => ({
      ...business,
      locationSource: 'openstreetmap_overpass',
      locationConfidence: best.locationConfidence,
      locationMatchMethod: best.matchMethod,
      matchedOsmId: best.feature.properties.osmId,
      matchedOsmType: best.feature.properties.osmType,
      matchedOsmName: best.feature.properties.name,
      matchedOsmAddress: best.feature.properties.address,
      matchedOsmTags: best.feature.properties.osmTags,
    }),
  })
}

async function buildBcGeocodedLocations(businessCandidates) {
  return buildBcGeocodedPointCollection(businessCandidates, {
    cachePath: BC_GEOCODER_CACHE,
    delayMs: BC_GEOCODER_DELAY_MS,
    minScore: BC_GEOCODER_MIN_SCORE,
    getAddress: (business) => business.address,
    buildProperties: (business, match) => {
      const score = Number(match?.properties?.score ?? 0)
      return {
        ...business,
        locationSource: 'bc_address_geocoder',
        locationConfidence: score >= 95 ? 'high' : 'medium',
        locationMatchMethod: 'address_geocode',
      }
    },
  })
}

export async function buildBusinessPois() {
  const businessRows = await loadBusinessLicences()
  const osmElements = await fetchOsmPois()
  const businessCandidates = businessRows.map(buildBusinessCandidate)
  const businessRowsByName = indexRecordsByName(businessRows, (row) => row.TradeName, {
    stopWords: ['ltd', 'limited', 'inc', 'corp', 'corporation', 'co', 'company', 'the', 'canada', 'bc', 'b-c'],
  })

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
        snapshotPath: sourcePath(CITYPG_BUSINESS_LICENCES_PATH),
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
        url: BC_ADDRESS_GEOCODER_URL,
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
