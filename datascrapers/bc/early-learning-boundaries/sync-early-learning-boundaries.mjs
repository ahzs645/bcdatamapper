import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import {
  area,
  bbox,
  intersect,
  union,
} from '@turf/turf'
import shp from 'shpjs'
import {
  MAPSHAPER_VERSION,
  simplifyPolygonTopology,
  TOPOLOGY_PROFILES,
} from '../../lib/mapshaper-topology.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const VENDOR_ROOT = join(SCRIPT_DIR, '..', '..', '..')
const OUTPUT_ROOT = join(SCRIPT_DIR, 'output')
const CACHE_ROOT = join(SCRIPT_DIR, 'cache')
const SCHOOL_OUTPUT_ROOT = join(OUTPUT_ROOT, 'BCSchoolDistricts')
const DASHBOARD_URL = 'https://dashboard.earlylearning.ubc.ca/'
const WFS_BASE = 'https://openmaps.gov.bc.ca/geo/pub'
const SCHOOL_LAYER = 'WHSE_TANTALIS.TA_SCHOOL_DISTRICTS_SVW'
const MCFD_SDA_LAYER = 'WHSE_ADMIN_BOUNDARIES.ADM_MCFD_SERVCE_DLVRY_AREAS_SP'
const MCFD_LSA_LAYER = 'WHSE_ADMIN_BOUNDARIES.ADM_MCFD_LOCAL_SERVCE_AREAS_SP'
const HELP_SHORELINES_URL = 'https://earlylearning.ubc.ca/app/uploads/2022/08/Neighbourhood_Shorelines.zip'
const EDI_WAVE_2_TO_8_URL = 'https://earlylearning.ubc.ca/app/uploads/2023/03/EDI_data_library_wave_2_to_8_by_all_region_type_sent.xlsx'
const MCFD_2013_REPORT_URL = 'https://www2.gov.bc.ca/assets/gov/family-and-social-supports/services-supports-for-parents-with-young-children/reporting-monitoring/03-operational-performance-strategic-management/mcfd_pmr_2013_14.pdf'
const SOURCE_CRS = 'EPSG:4326'
const WORKING_CRS = 'EPSG:3005'
const OUTPUT_CRS = 'EPSG:4326'
const COORDINATE_PRECISION = 6
const USER_AGENT = 'bcdatamapper/0.1 (+https://github.com/ahzs645/bcdatamapper)'

const TOLERANCE_METRES = Object.freeze({
  schoolDistricts: 50,
  helpNeighbourhoods: 25,
  mcfdRegions: 100,
  mcfdSdas: 100,
  mcfdLsas: 50,
})

function sha256(payload) {
  return createHash('sha256').update(payload).digest('hex')
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function compactGeoJson(collection) {
  return `${JSON.stringify(collection)}\n`
}

function gzipDeterministic(payload) {
  return gzipSync(payload, { level: 9, mtime: 0 })
}

function writeBuffer(path, payload) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, payload)
}

async function fetchBuffer(url, label) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!response.ok) {
    throw new Error(`Failed to fetch ${label}: ${response.status} ${response.statusText}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

async function fetchText(url, label) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!response.ok) {
    throw new Error(`Failed to fetch ${label}: ${response.status} ${response.statusText}`)
  }
  return response.text()
}

function fetchTextWithCurl(url, label) {
  try {
    return execFileSync('curl', [
      '--fail',
      '--location',
      '--silent',
      '--show-error',
      '--compressed',
      '--user-agent',
      USER_AGENT,
      url,
    ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  } catch (error) {
    throw new Error(`Failed to fetch ${label} with curl`, { cause: error })
  }
}

function wfsUrl(layer) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: `pub:${layer}`,
    outputFormat: 'application/json',
    srsName: SOURCE_CRS,
  })
  return `${WFS_BASE}/${layer}/ows?${params}`
}

function assertPolygonCollection(collection, label) {
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error(`${label} was not a GeoJSON FeatureCollection`)
  }
  for (const feature of collection.features) {
    if (!feature.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) {
      throw new Error(`${label} feature ${feature.id ?? '(unknown)'} did not contain polygon geometry`)
    }
  }
}

function normalizeSchoolDistricts(collection) {
  assertPolygonCollection(collection, 'School-district WFS response')
  return {
    type: 'FeatureCollection',
    features: collection.features.map((feature) => {
      const properties = feature.properties ?? {}
      const code = String(properties.SCHOOL_DISTRICT_NUMBER ?? '').trim()
      const name = String(properties.SCHOOL_DISTRICT_NAME ?? '').trim()
      if (!code || !name) throw new Error('School-district feature was missing its code or name')
      return {
        type: 'Feature',
        id: `GEOSD_${code}`,
        geometry: feature.geometry,
        properties: {
          boundaryCode: 'GEOSD',
          boundaryName: 'School District',
          regionId: `GEOSD_${code}`,
          regionCode: code,
          regionName: name,
          schoolDistrictNumber: Number(code),
          adminAreaSid: properties.ADMIN_AREA_SID ?? null,
          featureCode: properties.FEATURE_CODE ?? null,
          sourceAreaSqM: properties.FEATURE_AREA_SQM ?? null,
        },
      }
    }).sort(compareRegionCode),
  }
}

function normalizeHelpNeighbourhoods(collection) {
  assertPolygonCollection(collection, 'HELP neighbourhood shapefile')
  return {
    type: 'FeatureCollection',
    features: collection.features.map((feature) => {
      const properties = feature.properties ?? {}
      const code = String(properties.N_CODE ?? '').trim()
      const name = String(properties.N_NAME ?? '').trim()
      const rawSchoolDistrictCode = String(properties.SD_CODE ?? '').trim()
      const schoolDistrictCode = /^\d+$/u.test(rawSchoolDistrictCode)
        ? String(Number(rawSchoolDistrictCode))
        : rawSchoolDistrictCode
      const schoolDistrictName = String(properties.SD_NAME ?? '').trim()
      if (!code || !name || !schoolDistrictCode || !schoolDistrictName) {
        throw new Error('HELP neighbourhood feature was missing hierarchy fields')
      }
      return {
        type: 'Feature',
        id: code,
        geometry: feature.geometry,
        properties: {
          boundaryCode: 'NH',
          boundaryName: 'Neighbourhood',
          regionId: code,
          regionCode: code,
          regionName: name,
          parentBoundaryCode: 'GEOSD',
          parentRegionId: `GEOSD_${schoolDistrictCode}`,
          schoolDistrictCode,
          schoolDistrictName,
          sourceAreaSqM: properties.Shape_Area ?? null,
        },
      }
    }).sort(compareRegionCode),
  }
}

function normalizeMcfdSdas(collection) {
  assertPolygonCollection(collection, 'MCFD SDA WFS response')
  return {
    type: 'FeatureCollection',
    features: collection.features.map((feature) => {
      const properties = feature.properties ?? {}
      const code = String(properties.SERVICE_DELIVERY_AREA_NUMBER ?? '').trim()
      const name = String(properties.SERVICE_DELIVERY_AREA_NAME ?? '').trim()
      const regionCode = String(properties.REGION_NUMBER ?? '').trim()
      const regionName = String(properties.REGION_NAME ?? '').trim()
      if (!code || !name || !regionCode || !regionName) {
        throw new Error('MCFD SDA feature was missing hierarchy fields')
      }
      return {
        type: 'Feature',
        id: `SDA_${code}`,
        geometry: feature.geometry,
        properties: {
          boundaryCode: 'SDA',
          boundaryName: 'MCFD Service Delivery Area',
          regionId: `SDA_${code}`,
          regionCode: code,
          regionName: name,
          parentBoundaryCode: 'MCFD',
          parentRegionId: `MCFD_${regionCode}`,
          mcfdRegionCode: regionCode,
          mcfdRegionName: regionName,
          sourceAreaSqM: properties.FEATURE_AREA_SQM ?? null,
        },
      }
    }).sort(compareRegionCode),
  }
}

function normalizeMcfdLsas(collection) {
  assertPolygonCollection(collection, 'MCFD LSA WFS response')
  return {
    type: 'FeatureCollection',
    features: collection.features.map((feature) => {
      const properties = feature.properties ?? {}
      const code = String(properties.LOCAL_SERVICE_AREA_NUMBER ?? '').trim()
      const name = String(properties.LOCAL_SERVICE_AREA_NAME ?? '').trim()
      const sdaCode = String(properties.SERVICE_DELIVERY_AREA_NUMBER ?? '').trim()
      const sdaName = String(properties.SERVICE_DELIVERY_AREA_NAME ?? '').trim()
      const regionCode = String(properties.REGION_NUMBER ?? '').trim()
      const regionName = String(properties.REGION_NAME ?? '').trim()
      if (!code || !name || !sdaCode || !sdaName || !regionCode || !regionName) {
        throw new Error('MCFD LSA feature was missing hierarchy fields')
      }
      return {
        type: 'Feature',
        id: `LSA_${code}`,
        geometry: feature.geometry,
        properties: {
          boundaryCode: 'LSA',
          boundaryName: 'MCFD Local Service Area',
          regionId: `LSA_${code}`,
          regionCode: code,
          regionName: name,
          parentBoundaryCode: 'SDA',
          parentRegionId: `SDA_${sdaCode}`,
          serviceDeliveryAreaCode: sdaCode,
          serviceDeliveryAreaName: sdaName,
          mcfdRegionCode: regionCode,
          mcfdRegionName: regionName,
          sourceAreaSqM: properties.FEATURE_AREA_SQM ?? null,
        },
      }
    }).sort(compareRegionCode),
  }
}

function deriveMcfdRegions(sdas) {
  const names = new Map(sdas.features.map((feature) => [
    feature.properties.mcfdRegionCode,
    feature.properties.mcfdRegionName,
  ]))
  const grouped = new Map()
  for (const feature of sdas.features) {
    const code = feature.properties.mcfdRegionCode
    grouped.set(code, grouped.has(code) ? union(grouped.get(code), feature) : feature)
  }
  return {
    type: 'FeatureCollection',
    features: [...grouped].map(([rawCode, feature]) => {
      const code = String(rawCode).trim()
      const name = names.get(code)
      if (!code || !name) throw new Error('Dissolved MCFD Region was missing its code or name')
      return {
        type: 'Feature',
        id: `MCFD_${code}`,
        geometry: feature.geometry,
        properties: {
          boundaryCode: 'MCFD',
          boundaryName: 'MCFD Region',
          regionId: `MCFD_${code}`,
          regionCode: code,
          regionName: name.replace(/ Region$/u, ''),
          derivedFrom: 'SDA dissolve on REGION_NUMBER',
        },
      }
    }).sort(compareRegionCode),
  }
}

function compareRegionCode(a, b) {
  return String(a.properties?.regionCode ?? '').localeCompare(
    String(b.properties?.regionCode ?? ''),
    'en',
    { numeric: true },
  )
}

function simplifyLayer(collection, toleranceMetres, tempPrefix) {
  return simplifyPolygonTopology(collection, {
    toleranceMetres,
    topologyProfile: TOPOLOGY_PROFILES.PARTITION,
    sourceCrs: SOURCE_CRS,
    workingCrs: WORKING_CRS,
    outputCrs: OUTPUT_CRS,
    coordinatePrecision: COORDINATE_PRECISION,
    tempPrefix,
  })
}

function countPositions(geometry) {
  if (geometry.type === 'Polygon') {
    return geometry.coordinates.reduce((sum, ring) => sum + ring.length, 0)
  }
  return geometry.coordinates.reduce(
    (sum, polygon) => sum + polygon.reduce((inner, ring) => inner + ring.length, 0),
    0,
  )
}

function canonicalSegment(a, b) {
  const left = `${a[0]},${a[1]}`
  const right = `${b[0]},${b[1]}`
  return left < right ? `${left}|${right}` : `${right}|${left}`
}

function sharedSegmentSummary(collection) {
  const segmentOwners = new Map()
  for (const feature of collection.features) {
    const owner = String(feature.properties.regionId)
    const polygons = feature.geometry.type === 'Polygon'
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates
    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (let index = 1; index < ring.length; index += 1) {
          const key = canonicalSegment(ring[index - 1], ring[index])
          if (!segmentOwners.has(key)) segmentOwners.set(key, new Set())
          segmentOwners.get(key).add(owner)
        }
      }
    }
  }
  const shared = [...segmentOwners.values()].filter((owners) => owners.size > 1)
  return {
    uniqueSegmentCount: segmentOwners.size,
    exactSharedSegmentCount: shared.length,
    maximumOwnersPerSegment: Math.max(0, ...shared.map((owners) => owners.size)),
  }
}

function overlapSummary(collection) {
  const overlaps = []
  const bounds = collection.features.map((feature) => bbox(feature))
  for (let left = 0; left < collection.features.length; left += 1) {
    for (let right = left + 1; right < collection.features.length; right += 1) {
      if (
        bounds[left][2] < bounds[right][0] ||
        bounds[right][2] < bounds[left][0] ||
        bounds[left][3] < bounds[right][1] ||
        bounds[right][3] < bounds[left][1]
      ) continue
      const intersection = intersect(collection.features[left], collection.features[right])
      if (!intersection) continue
      const overlapAreaSqM = area(intersection)
      if (overlapAreaSqM > 1) {
        overlaps.push({
          left: collection.features[left].properties.regionId,
          right: collection.features[right].properties.regionId,
          overlapAreaSqM,
        })
      }
    }
  }
  return {
    pairwiseOverlapCountAboveOneSqM: overlaps.length,
    maximumOverlapAreaSqM: Math.max(0, ...overlaps.map((entry) => entry.overlapAreaSqM)),
    overlaps: overlaps.slice(0, 20),
  }
}

function areaChangeSummary(source, optimized) {
  const sourceById = new Map(source.features.map((feature) => [feature.properties.regionId, feature]))
  const changes = optimized.features.map((feature) => {
    const sourceFeature = sourceById.get(feature.properties.regionId)
    if (!sourceFeature) throw new Error(`Optimized feature ${feature.properties.regionId} was absent from source`)
    const sourceAreaSqM = area(sourceFeature)
    const optimizedAreaSqM = area(feature)
    return {
      regionId: feature.properties.regionId,
      percent: sourceAreaSqM === 0 ? 0 : Math.abs(optimizedAreaSqM - sourceAreaSqM) / sourceAreaSqM * 100,
    }
  }).sort((a, b) => b.percent - a.percent)
  return {
    maximumAbsoluteAreaChangePercent: changes[0]?.percent ?? 0,
    maximumAreaChangeRegionId: changes[0]?.regionId ?? null,
  }
}

function validateLayer(source, optimized, expectedCount) {
  if (source.features.length !== expectedCount || optimized.features.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} features; found ${source.features.length} source and ${optimized.features.length} optimized`)
  }
  const sourceIds = source.features.map((feature) => feature.properties.regionId)
  const optimizedIds = optimized.features.map((feature) => feature.properties.regionId)
  if (new Set(sourceIds).size !== expectedCount || new Set(optimizedIds).size !== expectedCount) {
    throw new Error('Boundary layer contained duplicate identifiers')
  }
  if (sourceIds.some((id, index) => id !== optimizedIds[index])) {
    throw new Error('Boundary identifiers or deterministic ordering changed during optimization')
  }
  return {
    expectedFeatureCount: expectedCount,
    identifiersUniqueAndStable: true,
    ...sharedSegmentSummary(optimized),
    ...overlapSummary(optimized),
    ...areaChangeSummary(source, optimized),
  }
}

function parseDashboardRegions(html) {
  const match = html.match(/const REGION_SEARCH_DATA = (\[[\s\S]*?\]);/u)
  if (!match) throw new Error('Could not find REGION_SEARCH_DATA in the EDI dashboard HTML')
  const records = JSON.parse(match[1])
  return Object.fromEntries(['GEOSD', 'NH', 'MCFD', 'SDA', 'LSA'].map((boundaryCode) => [
    boundaryCode,
    records
      .filter((record) => record.boundaryCode === boundaryCode && record.regionCode !== 'ALL')
      .map((record) => ({ code: String(record.regionCode), name: String(record.regionName) }))
      .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true })),
  ]))
}

function codeDifference(left, right) {
  const rightCodes = new Set(right.map((entry) => entry.code))
  return left.filter((entry) => !rightCodes.has(entry.code))
}

function layerMetrics({ source, optimized, archivePayload, toleranceMetres, validation }) {
  const sourcePayload = compactGeoJson(source)
  const optimizedPayload = compactGeoJson(optimized)
  return {
    featureCount: optimized.features.length,
    toleranceMetres,
    rawVertexCount: source.features.reduce((sum, feature) => sum + countPositions(feature.geometry), 0),
    optimizedVertexCount: optimized.features.reduce((sum, feature) => sum + countPositions(feature.geometry), 0),
    sourceBytes: Buffer.byteLength(sourcePayload),
    sourceGzipBytes: gzipDeterministic(sourcePayload).length,
    optimizedBytes: Buffer.byteLength(optimizedPayload),
    gzipBytes: gzipDeterministic(optimizedPayload).length,
    sourceSha256: sha256(sourcePayload),
    optimizedSha256: sha256(optimizedPayload),
    ...(archivePayload ? {
      sourceArchiveBytes: archivePayload.length,
      sourceArchiveSha256: sha256(archivePayload),
    } : {}),
    validation,
  }
}

function addMetadata(collection, metadata) {
  return {
    type: 'FeatureCollection',
    name: metadata.name,
    metadata: {
      sourceCrs: SOURCE_CRS,
      workingCrs: WORKING_CRS,
      outputCrs: OUTPUT_CRS,
      simplification: 'Mapshaper shared-topology Ramer-Douglas-Peucker',
      topologyProfile: TOPOLOGY_PROFILES.PARTITION,
      topologyPreserving: true,
      mapshaperVersion: MAPSHAPER_VERSION,
      coordinatePrecision: COORDINATE_PRECISION,
      ...collection.metadata,
      ...metadata,
    },
    features: collection.features.sort(compareRegionCode),
  }
}

mkdirSync(OUTPUT_ROOT, { recursive: true })
mkdirSync(CACHE_ROOT, { recursive: true })

const [schoolText, helpZip, ediWave2To8Workbook, mcfd2013Report, mcfdSdaText, mcfdLsaText] = await Promise.all([
  fetchText(wfsUrl(SCHOOL_LAYER), 'BC school districts'),
  fetchBuffer(HELP_SHORELINES_URL, 'HELP neighbourhood shapefile'),
  fetchBuffer(EDI_WAVE_2_TO_8_URL, 'HELP EDI Wave 2-8 aggregate workbook'),
  fetchBuffer(MCFD_2013_REPORT_URL, 'historical MCFD LSA map and inventory'),
  fetchText(wfsUrl(MCFD_SDA_LAYER), 'MCFD Service Delivery Areas'),
  fetchText(wfsUrl(MCFD_LSA_LAYER), 'MCFD Local Service Areas'),
])
// The dashboard server currently presents a certificate chain that Node's TLS
// verifier rejects even with the macOS system CA store. curl validates the same
// endpoint successfully, so use it only for this small public HTML inventory.
const dashboardHtml = fetchTextWithCurl(DASHBOARD_URL, 'UBC EDI dashboard')

writeBuffer(join(CACHE_ROOT, 'Neighbourhood_Shorelines.zip'), helpZip)
writeBuffer(join(CACHE_ROOT, 'EDI_data_library_wave_2_to_8.xlsx'), ediWave2To8Workbook)
writeBuffer(join(CACHE_ROOT, 'mcfd_pmr_2013_14.pdf'), mcfd2013Report)
writeBuffer(join(CACHE_ROOT, 'mcfd-service-delivery-areas.source.geojson'), mcfdSdaText)
writeBuffer(join(CACHE_ROOT, 'mcfd-local-service-areas.source.geojson'), mcfdLsaText)

const parsedHelp = await shp(helpZip)
const helpShape = Array.isArray(parsedHelp) ? parsedHelp[0] : parsedHelp
const dashboard = parseDashboardRegions(dashboardHtml)

const schoolSource = normalizeSchoolDistricts(JSON.parse(schoolText))
const helpSource = normalizeHelpNeighbourhoods(helpShape)
const mcfdSdaSource = normalizeMcfdSdas(JSON.parse(mcfdSdaText))
const mcfdLsaSource = normalizeMcfdLsas(JSON.parse(mcfdLsaText))
const mcfdRegionSource = deriveMcfdRegions(mcfdSdaSource)

const schoolSimplified = simplifyLayer(schoolSource, TOLERANCE_METRES.schoolDistricts, 'bc-school-districts-')
const helpSimplified = simplifyLayer(helpSource, TOLERANCE_METRES.helpNeighbourhoods, 'help-neighbourhoods-')
const mcfdRegionSimplified = simplifyLayer(mcfdRegionSource, TOLERANCE_METRES.mcfdRegions, 'mcfd-regions-')
const mcfdSdaSimplified = simplifyLayer(mcfdSdaSource, TOLERANCE_METRES.mcfdSdas, 'mcfd-sdas-')
const mcfdLsaSimplified = simplifyLayer(mcfdLsaSource, TOLERANCE_METRES.mcfdLsas, 'mcfd-lsas-')

const schoolOutput = addMetadata(schoolSimplified, {
  name: 'BC school districts',
  source: 'BC Geographic Warehouse',
  sourceLayer: SCHOOL_LAYER,
  catalogueUrl: 'https://catalogue.data.gov.bc.ca/dataset/78ec5279-4534-49a1-97e8-9d315936f08b',
  licence: 'Open Government Licence - British Columbia',
  licenceUrl: 'https://www2.gov.bc.ca/gov/content/data/open-data/open-government-licence-bc',
  coverage: 'Current legal school-district administrative areas in British Columbia',
  simplificationToleranceMetres: TOLERANCE_METRES.schoolDistricts,
})
const schoolPayload = compactGeoJson(schoolOutput)
writeBuffer(join(SCHOOL_OUTPUT_ROOT, 'school_districts.geojson'), schoolPayload)
writeBuffer(join(SCHOOL_OUTPUT_ROOT, 'school_districts.geojson.gz'), gzipDeterministic(schoolPayload))

const restrictedOutputs = [
  ['help_neighbourhoods.geojson', helpSimplified],
  ['mcfd_regions.geojson', mcfdRegionSimplified],
  ['mcfd_service_delivery_areas.geojson', mcfdSdaSimplified],
  ['mcfd_local_service_areas.geojson', mcfdLsaSimplified],
]
for (const [file, collection] of restrictedOutputs) {
  writeBuffer(join(CACHE_ROOT, file), compactGeoJson(collection))
}

const schoolValidation = validateLayer(schoolSource, schoolSimplified, 59)
const helpValidation = validateLayer(helpSource, helpSimplified, 300)
const mcfdRegionValidation = validateLayer(mcfdRegionSource, mcfdRegionSimplified, 4)
const mcfdSdaValidation = validateLayer(mcfdSdaSource, mcfdSdaSimplified, 13)
const mcfdLsaValidation = validateLayer(mcfdLsaSource, mcfdLsaSimplified, 45)

const schoolCodes = schoolSource.features.map((feature) => ({
  code: feature.properties.regionCode,
  name: feature.properties.regionName,
}))
const helpCodes = helpSource.features.map((feature) => ({
  code: feature.properties.regionCode,
  name: feature.properties.regionName,
}))
const mcfdRegionCodes = mcfdRegionSource.features.map((feature) => ({
  code: feature.properties.regionCode,
  name: feature.properties.regionName,
}))
const mcfdSdaCodes = mcfdSdaSource.features.map((feature) => ({
  code: feature.properties.regionCode,
  name: feature.properties.regionName,
}))
const mcfdLsaCodes = mcfdLsaSource.features.map((feature) => ({
  code: feature.properties.regionCode,
  name: feature.properties.regionName,
}))
const schoolCodeSet = new Set(schoolCodes.map((entry) => entry.code))
const sdaByCode = new Map(mcfdSdaSource.features.map((feature) => [feature.properties.regionCode, feature]))
const dashboardLsaCodeSet = new Set(dashboard.LSA.map((entry) => entry.code))
const dashboardMapLsaCodeSet = new Set([
  ...mcfdLsaSource.features.map((feature) => feature.properties.regionCode),
  '2528',
  '2529',
])
const historicalParent = mcfdLsaSource.features.find((feature) => feature.properties.regionCode === '2527')
if (!historicalParent) throw new Error('MCFD LSA source did not contain parent template 2527')

const historicalMcfdLsaRecords = [
  ...mcfdLsaSource.features.map((feature) => ({
    code: feature.properties.regionCode,
    name: feature.properties.regionName,
    serviceDeliveryAreaCode: feature.properties.serviceDeliveryAreaCode,
    serviceDeliveryAreaName: feature.properties.serviceDeliveryAreaName,
    mcfdRegionCode: feature.properties.mcfdRegionCode,
    mcfdRegionName: feature.properties.mcfdRegionName,
    official2011Inventory: true,
    ediDashboardInventory: dashboardLsaCodeSet.has(feature.properties.regionCode),
    ediDashboardMapGeometryInventory: dashboardMapLsaCodeSet.has(feature.properties.regionCode),
    dataBcGeometryInventory: true,
    geometryStatus: 'available-in-restricted-local-cache',
  })),
  ...[
    { code: '2528', name: 'Bella Coola Valley' },
    { code: '2529', name: 'Central Coast' },
  ].map((record) => ({
    ...record,
    serviceDeliveryAreaCode: historicalParent.properties.serviceDeliveryAreaCode,
    serviceDeliveryAreaName: historicalParent.properties.serviceDeliveryAreaName,
    mcfdRegionCode: historicalParent.properties.mcfdRegionCode,
    mcfdRegionName: historicalParent.properties.mcfdRegionName,
    official2011Inventory: true,
    ediDashboardInventory: dashboardLsaCodeSet.has(record.code),
    ediDashboardMapGeometryInventory: dashboardMapLsaCodeSet.has(record.code),
    dataBcGeometryInventory: false,
    geometryStatus: 'available-from-dashboard-runtime-capture-local-only',
  })),
].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))

if (historicalMcfdLsaRecords.length !== 47) {
  throw new Error(`Expected 47 historical MCFD LSA index records; found ${historicalMcfdLsaRecords.length}`)
}
const indexedDashboardLsaCount = historicalMcfdLsaRecords.filter((record) => record.ediDashboardInventory).length
const indexedDashboardMapGeometryCount = historicalMcfdLsaRecords.filter((record) => record.ediDashboardMapGeometryInventory).length
const indexedGeometryLsaCount = historicalMcfdLsaRecords.filter((record) => record.dataBcGeometryInventory).length
if (indexedDashboardLsaCount !== 46 || indexedDashboardMapGeometryCount !== 47 || indexedGeometryLsaCount !== 45) {
  throw new Error(`Unexpected MCFD LSA index membership: dashboard search=${indexedDashboardLsaCount}, dashboard map=${indexedDashboardMapGeometryCount}, DataBC geometry=${indexedGeometryLsaCount}`)
}

const report = {
  name: 'BC early-learning boundary source audit',
  processing: {
    sourceCrs: SOURCE_CRS,
    workingCrs: WORKING_CRS,
    outputCrs: OUTPUT_CRS,
    topologyProfile: TOPOLOGY_PROFILES.PARTITION,
    mapshaperVersion: MAPSHAPER_VERSION,
    coordinatePrecision: COORDINATE_PRECISION,
  },
  dataInputs: {
    ediWave2To8AggregateWorkbook: {
      sourceUrl: EDI_WAVE_2_TO_8_URL,
      redistributable: false,
      restriction: 'No dataset-specific open licence; UBC Terms of Use require permission to republish or redisseminate.',
      cacheFile: 'cache/EDI_data_library_wave_2_to_8.xlsx',
      sourceBytes: ediWave2To8Workbook.length,
      sourceSha256: sha256(ediWave2To8Workbook),
      dataLevel: 'Suppressed aggregate results by geography; not child-level EDI records.',
      waves: [2, 3, 4, 5, 6, 7, 8],
      geographySheets: [
        'Province',
        'Neighbourhood',
        'School district',
        'Health Authority',
        'Health Service Delivery Area',
        'Local Health Area',
        'CHSA',
        'MCFD',
        'Service Delivery Area',
        'Local Service Area',
      ],
      note: 'The live dashboard includes Wave 9, but no public Wave 9 bulk workbook was identified in the HELP Data Library.',
    },
  },
  sourceDocuments: {
    mcfdHistorical2011LsaInventory: {
      sourceUrl: MCFD_2013_REPORT_URL,
      cacheFile: 'cache/mcfd_pmr_2013_14.pdf',
      sourceBytes: mcfd2013Report.length,
      sourceSha256: sha256(mcfd2013Report),
      evidence: 'PDF page 10 (printed page 3) states 13 SDAs and 47 LSAs and maps/lists 2528 Bella Coola Valley and 2529 Central Coast.',
      geometryUsability: 'The map is embedded as a raster image, so it is authoritative inventory evidence but not authoritative extractable polygon geometry.',
    },
    ediDashboardRuntimeLsaGeometry: {
      sourceUrl: DASHBOARD_URL,
      featureCount: indexedDashboardMapGeometryCount,
      searchIndexFeatureCount: indexedDashboardLsaCount,
      includesUnsearchableLsa2529: true,
      captureCommand: 'npm run early-learning-boundaries:capture-dashboard-lsa',
      cacheFile: 'cache/dashboard_mcfd_local_service_areas.geojson',
      redistributable: false,
      restriction: 'No dataset-specific open redistribution licence; keep the runtime capture in the ignored local cache pending written permission.',
      evidence: 'The live scalesMap Leaflet layer registry exposes 47 LSA polygon layers, including LSA_2528 and LSA_2529.',
    },
  },
  layers: {
    schoolDistricts: {
      redistributable: true,
      sourceLayer: SCHOOL_LAYER,
      ...layerMetrics({
        source: schoolSource,
        optimized: schoolOutput,
        toleranceMetres: TOLERANCE_METRES.schoolDistricts,
        validation: schoolValidation,
      }),
    },
    helpNeighbourhoods: {
      redistributable: false,
      restriction: 'No dataset-specific open licence; UBC Terms of Use require permission to republish or redisseminate.',
      sourceUrl: HELP_SHORELINES_URL,
      ...layerMetrics({
        source: helpSource,
        optimized: helpSimplified,
        archivePayload: helpZip,
        toleranceMetres: TOLERANCE_METRES.helpNeighbourhoods,
        validation: helpValidation,
      }),
    },
    mcfdRegions: {
      redistributable: false,
      restriction: 'Derived from an Access Only SDA service.',
      derivation: 'Dissolve SDA geometry on REGION_NUMBER.',
      ...layerMetrics({
        source: mcfdRegionSource,
        optimized: mcfdRegionSimplified,
        toleranceMetres: TOLERANCE_METRES.mcfdRegions,
        validation: mcfdRegionValidation,
      }),
    },
    mcfdServiceDeliveryAreas: {
      redistributable: false,
      restriction: 'BC Data Catalogue licence is Access Only.',
      sourceLayer: MCFD_SDA_LAYER,
      ...layerMetrics({
        source: mcfdSdaSource,
        optimized: mcfdSdaSimplified,
        toleranceMetres: TOLERANCE_METRES.mcfdSdas,
        validation: mcfdSdaValidation,
      }),
    },
    mcfdLocalServiceAreas: {
      redistributable: false,
      restriction: 'BC Data Catalogue licence is Access Only.',
      sourceLayer: MCFD_LSA_LAYER,
      ...layerMetrics({
        source: mcfdLsaSource,
        optimized: mcfdLsaSimplified,
        toleranceMetres: TOLERANCE_METRES.mcfdLsas,
        validation: mcfdLsaValidation,
      }),
    },
  },
  hierarchy: {
    education: {
      sourceSchoolDistrictCount: schoolSource.features.length,
      sourceHelpNeighbourhoodCount: helpSource.features.length,
      helpParentSchoolDistrictCount: new Set(helpSource.features.map((feature) => feature.properties.schoolDistrictCode)).size,
      helpFeaturesWithExplicitParent: helpSource.features.filter((feature) => feature.properties.schoolDistrictCode).length,
      helpParentCodesMissingFromCurrentSchoolDistricts: [...new Set(helpSource.features
        .map((feature) => feature.properties.schoolDistrictCode)
        .filter((code) => !schoolCodeSet.has(code)))].sort(),
      dashboardSchoolDistrictCount: dashboard.GEOSD.length,
      dashboardHelpNeighbourhoodCount: dashboard.NH.length,
      schoolDistrictsOnlyInSource: codeDifference(schoolCodes, dashboard.GEOSD),
      schoolDistrictsOnlyInDashboard: codeDifference(dashboard.GEOSD, schoolCodes),
      helpNeighbourhoodsOnlyInPublishedShapefile: codeDifference(helpCodes, dashboard.NH),
      helpNeighbourhoodsOnlyInDashboard: codeDifference(dashboard.NH, helpCodes),
    },
    mcfdDashboardVintage: {
      sourceRegionCount: mcfdRegionSource.features.length,
      sourceServiceDeliveryAreaCount: mcfdSdaSource.features.length,
      sourceLocalServiceAreaCount: mcfdLsaSource.features.length,
      dashboardRegionCount: dashboard.MCFD.length,
      dashboardServiceDeliveryAreaCount: dashboard.SDA.length,
      dashboardLocalServiceAreaCount: dashboard.LSA.length,
      sdasWithExplicitRegionParent: mcfdSdaSource.features.filter((feature) => feature.properties.mcfdRegionCode).length,
      lsasWithExplicitSdaAndRegionParents: mcfdLsaSource.features.filter((feature) => (
        feature.properties.serviceDeliveryAreaCode && feature.properties.mcfdRegionCode
      )).length,
      lsaParentCodesMissingFromSdaSource: [...new Set(mcfdLsaSource.features
        .map((feature) => feature.properties.serviceDeliveryAreaCode)
        .filter((code) => !sdaByCode.has(code)))].sort(),
      lsaParentRegionMismatches: mcfdLsaSource.features.filter((feature) => (
        sdaByCode.get(feature.properties.serviceDeliveryAreaCode)?.properties.mcfdRegionCode !== feature.properties.mcfdRegionCode
      )).map((feature) => feature.properties.regionId),
      regionsOnlyInSource: codeDifference(mcfdRegionCodes, dashboard.MCFD),
      regionsOnlyInDashboard: codeDifference(dashboard.MCFD, mcfdRegionCodes),
      sdasOnlyInSource: codeDifference(mcfdSdaCodes, dashboard.SDA),
      sdasOnlyInDashboard: codeDifference(dashboard.SDA, mcfdSdaCodes),
      lsasOnlyInSource: codeDifference(mcfdLsaCodes, dashboard.LSA),
      lsasOnlyInDashboard: codeDifference(dashboard.LSA, mcfdLsaCodes),
    },
    mcfdCurrentOrganization: {
      effectiveFiscalYear: '2024/25',
      documentedServiceDeliveryAreaCount: 7,
      documentedLocalServiceAreaCount: 44,
      sourceUrl: 'https://mcfd.gov.bc.ca/reporting/about-us/how-we-are-organized',
      geometryStatus: 'No authoritative downloadable current-vintage geometry identified; do not label the Access Only 4/13/45 service as current.',
    },
  },
}

const boundaryIndex = {
  name: 'BC early-learning boundary file index',
  hierarchy: {
    education: ['GEOSD', 'NH'],
    childrenAndFamily: ['MCFD', 'SDA', 'LSA'],
  },
  boundaryTypes: [
    {
      code: 'GEOSD',
      name: 'School District',
      featureCount: schoolOutput.features.length,
      file: 'BCSchoolDistricts/school_districts.geojson',
      availability: 'deployable-output',
      redistributable: true,
      geometryRole: 'Canonical official geometry; HELP neighbourhoods can be dissolved by SD_CODE for a same-vintage comparison only.',
    },
    {
      code: 'NH',
      name: 'HELP Neighbourhood',
      featureCount: helpSimplified.features.length,
      file: '../cache/help_neighbourhoods.geojson',
      availability: 'local-cache',
      redistributable: false,
      parentBoundaryCode: 'GEOSD',
      parentProperty: 'parentRegionId',
    },
    {
      code: 'MCFD',
      name: 'MCFD Region',
      featureCount: mcfdRegionSimplified.features.length,
      file: '../cache/mcfd_regions.geojson',
      availability: 'local-cache',
      redistributable: false,
      derivedFromBoundaryCode: 'SDA',
      derivation: 'Dissolve SDA geometry on REGION_NUMBER.',
    },
    {
      code: 'SDA',
      name: 'MCFD Service Delivery Area',
      featureCount: mcfdSdaSimplified.features.length,
      file: '../cache/mcfd_service_delivery_areas.geojson',
      availability: 'local-cache',
      redistributable: false,
      parentBoundaryCode: 'MCFD',
      parentProperty: 'parentRegionId',
      aggregationNote: 'Can be dissolved from the complete 47-feature dashboard runtime snapshot. The current DataBC LSA service has only 45 features.',
    },
    {
      code: 'LSA',
      name: 'MCFD Local Service Area',
      featureCount: mcfdLsaSimplified.features.length,
      file: '../cache/mcfd_local_service_areas.geojson',
      availability: 'local-cache',
      redistributable: false,
      parentBoundaryCode: 'SDA',
      parentProperty: 'parentRegionId',
    },
  ],
  mcfdLsaVintageIndex: {
    official2011: {
      featureCount: historicalMcfdLsaRecords.length,
      sourceUrl: MCFD_2013_REPORT_URL,
      geometryFormat: 'Raster map in official PDF; codes and names are indexable, polygons are not extractable as authoritative vectors.',
    },
    ediDashboardSearchIndex: {
      featureCount: dashboard.LSA.length,
      sourceUrl: DASHBOARD_URL,
    },
    ediDashboardMapGeometry: {
      featureCount: indexedDashboardMapGeometryCount,
      sourceUrl: DASHBOARD_URL,
      delivery: 'Shiny Leaflet runtime layers; no stable standalone download URL identified.',
      captureCommand: 'npm run early-learning-boundaries:capture-dashboard-lsa',
      cacheFile: '../cache/dashboard_mcfd_local_service_areas.geojson',
      redistributable: false,
    },
    dataBcGeometry: {
      featureCount: mcfdLsaSource.features.length,
      sourceLayer: MCFD_LSA_LAYER,
      licence: 'Access Only',
    },
    records: historicalMcfdLsaRecords,
  },
}

writeBuffer(join(OUTPUT_ROOT, 'audit-report.json'), stableStringify(report))
writeBuffer(join(OUTPUT_ROOT, 'index.json'), stableStringify(boundaryIndex))

console.log(stableStringify({
  output: 'datascrapers/bc/early-learning-boundaries/output',
  schoolDistricts: report.layers.schoolDistricts,
  helpNeighbourhoods: report.layers.helpNeighbourhoods,
  mcfdRegions: report.layers.mcfdRegions,
  mcfdServiceDeliveryAreas: report.layers.mcfdServiceDeliveryAreas,
  mcfdLocalServiceAreas: report.layers.mcfdLocalServiceAreas,
  hierarchy: report.hierarchy,
}))
