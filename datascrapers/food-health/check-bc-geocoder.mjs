import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  bcAddressQuery,
  bcGeocodeFeatureProperties,
  geocodeBcAddressQueries,
  isAcceptedBcGeocode,
  normalizeBcAddress,
  BC_ADDRESS_GEOCODER_URL,
} from '../bc/geocoder/bc-address-geocoder.mjs'
import { writeJson } from '../healthyplan-pg/lib/shared.mjs'

const DEFAULT_RESTAURANTS = 'public/data/restaurants.json'
const DEFAULT_OUTPUT = 'public/data/food-health/restaurants_bc_geocoder_check.json'
const DEFAULT_CACHE = 'public/data/food-health/restaurants_bc_geocode_cache.json'
const DELAY_MS = Number(process.env.BC_GEOCODER_DELAY_MS ?? 75)
const MIN_SCORE = Number(process.env.BC_GEOCODER_MIN_SCORE ?? 75)

function distanceMeters(a, b) {
  const earthRadius = 6371000
  const toRadians = (degrees) => (degrees * Math.PI) / 180
  const lat1 = toRadians(a[1])
  const lat2 = toRadians(b[1])
  const deltaLat = toRadians(b[1] - a[1])
  const deltaLon = toRadians(b[0] - a[0])
  const h =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2
  return 2 * earthRadius * Math.asin(Math.sqrt(h))
}

function restaurantAddress(restaurant) {
  return restaurant.address || restaurant.full_address || ''
}

function parseArgs(argv) {
  const args = {
    restaurants: DEFAULT_RESTAURANTS,
    output: DEFAULT_OUTPUT,
    cache: DEFAULT_CACHE,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--restaurants') args.restaurants = argv[index + 1]
    if (value === '--output') args.output = argv[index + 1]
    if (value === '--cache') args.cache = argv[index + 1]
  }
  return args
}

export async function checkFoodHealthBcGeocoder(options = {}) {
  const restaurantsPath = options.restaurants ?? DEFAULT_RESTAURANTS
  const outputPath = options.output ?? DEFAULT_OUTPUT
  const cachePath = options.cache ?? DEFAULT_CACHE
  const restaurants = JSON.parse(await readFile(restaurantsPath, 'utf8'))
  const queries = restaurants.map((restaurant) => bcAddressQuery(restaurantAddress(restaurant)))
  const geocoded = await geocodeBcAddressQueries(queries, {
    cachePath,
    delayMs: options.delayMs ?? DELAY_MS,
    minScore: options.minScore ?? MIN_SCORE,
  })

  const records = restaurants.map((restaurant, index) => {
    const sourceAddress = restaurantAddress(restaurant)
    const query = bcAddressQuery(sourceAddress)
    const match = geocoded.cache[query]
    const accepted = isAcceptedBcGeocode(match, { minScore: options.minScore ?? MIN_SCORE })
    const sourceCoords =
      Number.isFinite(Number(restaurant.longitude)) && Number.isFinite(Number(restaurant.latitude))
        ? [Number(restaurant.longitude), Number(restaurant.latitude)]
        : null
    const geocoderCoords = accepted ? match.geometry.coordinates : null
    return {
      index,
      name: restaurant.name,
      sourceAddress,
      sourceNormalizedAddress: normalizeBcAddress(sourceAddress),
      sourceLatitude: restaurant.latitude ?? null,
      sourceLongitude: restaurant.longitude ?? null,
      query,
      accepted,
      distanceMeters:
        sourceCoords && geocoderCoords ? Math.round(distanceMeters(sourceCoords, geocoderCoords) * 10) / 10 : null,
      ...(accepted ? bcGeocodeFeatureProperties(match) : { geocodeStatus: match?.status ?? 'not_queried' }),
    }
  })

  const withSourceCoords = records.filter((record) => record.sourceLatitude && record.sourceLongitude)
  const accepted = records.filter((record) => record.accepted)
  const summary = {
    generatedAt: new Date().toISOString(),
    source: restaurantsPath,
    geocoderUrl: BC_ADDRESS_GEOCODER_URL,
    totalRows: records.length,
    uniqueAddressQueries: geocoded.uniqueQueryCount,
    newRequestsThisRun: geocoded.requested,
    acceptedRows: accepted.length,
    existingCoordinateRows: withSourceCoords.length,
    acceptedRowsWithExistingCoordinates: accepted.filter(
      (record) => record.sourceLatitude != null && record.sourceLongitude != null,
    ).length,
    distanceBucketsMeters: {
      within25: accepted.filter((record) => record.distanceMeters != null && record.distanceMeters <= 25).length,
      within100: accepted.filter((record) => record.distanceMeters != null && record.distanceMeters <= 100).length,
      within250: accepted.filter((record) => record.distanceMeters != null && record.distanceMeters <= 250).length,
      over250: accepted.filter((record) => record.distanceMeters != null && record.distanceMeters > 250).length,
    },
  }

  await writeJson(outputPath, { summary, records })
  await writeJson(cachePath, geocoded.cache)
  console.log(`Food health rows: ${summary.totalRows}`)
  console.log(`BC geocoder accepted rows: ${summary.acceptedRows}`)
  console.log(`Existing coordinate rows: ${summary.existingCoordinateRows}`)
  console.log(`New BC geocoder requests: ${summary.newRequestsThisRun}`)
  console.log(`Output: ${outputPath}`)
  return { summary, records }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkFoodHealthBcGeocoder(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
