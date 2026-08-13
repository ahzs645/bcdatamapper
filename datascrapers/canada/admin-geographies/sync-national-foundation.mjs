#!/usr/bin/env node
/* global Buffer, URLSearchParams, console, fetch, process, setTimeout */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const STATCAN_CSD_2025 =
  'https://geo.statcan.gc.ca/geo_wa/rest/services/2025/lcsd000a25s_e/MapServer/0'
const STATCAN_CD_2021 =
  'https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer/4'
const CLSS_INDIGENOUS_LANDS =
  'https://proxyinternet.nrcan.gc.ca/arcgis/rest/services/CLSS-SATC/CLSS_Administrative_Boundaries/MapServer/0'
const STATCAN_CSD_TYPE_TABLE =
  'https://www150.statcan.gc.ca/n1/pub/92-162-g/2025001/tbl/tbl4.2-eng.htm'
const STATCAN_CD_TYPE_TABLE =
  'https://www150.statcan.gc.ca/n1/pub/92-162-g/2025001/tbl/tbl4.3-eng.htm'
const NL_LAND_USE_SERVICE =
  'https://dnrmaps.gov.nl.ca/arcgis/rest/services/GeoAtlas/Land_Use/MapServer'

const PROVINCES_AND_TERRITORIES = [
  ['10', 'Newfoundland and Labrador'],
  ['11', 'Prince Edward Island'],
  ['12', 'Nova Scotia'],
  ['13', 'New Brunswick'],
  ['24', 'Quebec'],
  ['35', 'Ontario'],
  ['46', 'Manitoba'],
  ['47', 'Saskatchewan'],
  ['48', 'Alberta'],
  ['59', 'British Columbia'],
  ['60', 'Yukon'],
  ['61', 'Northwest Territories'],
  ['62', 'Nunavut'],
]

const PROVINCE_NAMES = new Map(PROVINCES_AND_TERRITORIES)
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output')
const CSD_DIR = path.join(OUTPUT_DIR, 'national', 'census-subdivisions-2025')
const CD_DIR = path.join(OUTPUT_DIR, 'national', 'census-divisions-2021')
const LEGACY_CD_PATH = path.join(OUTPUT_DIR, 'national', 'census-divisions-2021.geojson.gz')
const INDIGENOUS_PATH = path.join(OUTPUT_DIR, 'national', 'indigenous-lands-clss.geojson.gz')
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')
const GEOMETRY_PRECISION = 7
const DEFAULT_PAGE_SIZE = 200
const FETCH_RETRIES = 4
const RETRY_BASE_DELAY_MS = 750
const FETCH_TIMEOUT_MS = 45_000

const resume = process.argv.includes('--resume')
const skipCsd = process.argv.includes('--skip-csd')
const skipCd = process.argv.includes('--skip-cd')
const skipIndigenous = process.argv.includes('--skip-indigenous')
const skipProvincial = process.argv.includes('--skip-provincial')

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function decodeHtml(value) {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&eacute;/g, 'é')
    .replace(/&Eacute;/g, 'É')
    .replace(/&agrave;/g, 'à')
    .replace(/&ocirc;/g, 'ô')
    .replace(/&icirc;/g, 'î')
    .replace(/&uuml;/g, 'ü')
    .replace(/&ccedil;/g, 'ç')
    .replace(/&ecirc;/g, 'ê')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function stableFeatureSort(features, property) {
  return features.sort((left, right) =>
    String(left.properties?.[property] ?? '').localeCompare(
      String(right.properties?.[property] ?? ''),
    ),
  )
}

function countBy(features, property) {
  const counts = {}
  for (const feature of features) {
    const value = String(feature.properties?.[property] ?? 'Unknown') || 'Unknown'
    counts[value] = (counts[value] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

function extendBbox(bbox, coordinates) {
  if (!Array.isArray(coordinates)) return
  if (typeof coordinates[0] === 'number') {
    bbox[0] = Math.min(bbox[0], coordinates[0])
    bbox[1] = Math.min(bbox[1], coordinates[1])
    bbox[2] = Math.max(bbox[2], coordinates[0])
    bbox[3] = Math.max(bbox[3], coordinates[1])
    return
  }
  for (const nested of coordinates) extendBbox(bbox, nested)
}

function featureCollectionBbox(features) {
  const bbox = [Infinity, Infinity, -Infinity, -Infinity]
  for (const feature of features) extendBbox(bbox, feature.geometry?.coordinates)
  return bbox.map((value) => Number(value.toFixed(GEOMETRY_PRECISION)))
}

function hasPolygonGeometry(feature) {
  return feature?.geometry?.type === 'Polygon' || feature?.geometry?.type === 'MultiPolygon'
}

async function fetchJson(url, attempt = 1) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'BCDataMapper/CanadaAdministrativeGeographies' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const body = await response.text()
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 300)}`)
    }
    const json = JSON.parse(body)
    if (json.error) throw new Error(`ArcGIS error: ${JSON.stringify(json.error)}`)
    return json
  } catch (error) {
    if (attempt >= FETCH_RETRIES) throw error
    await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
    return fetchJson(url, attempt + 1)
  }
}

async function fetchLayerMetadata(serviceUrl) {
  return fetchJson(`${serviceUrl}?f=pjson`)
}

async function fetchObjectIds(serviceUrl, where = '1=1') {
  const params = new URLSearchParams({ where, returnIdsOnly: 'true', f: 'json' })
  const json = await fetchJson(`${serviceUrl}/query?${params}`)
  return (Array.isArray(json.objectIds) ? json.objectIds : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
}

async function queryObjectIds(serviceUrl, objectIds, outFields, extraParams = {}) {
  const params = new URLSearchParams({
    objectIds: objectIds.join(','),
    outFields,
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: String(GEOMETRY_PRECISION),
    f: 'geojson',
  })
  for (const [key, value] of Object.entries(extraParams)) params.set(key, String(value))

  try {
    const json = await fetchJson(`${serviceUrl}/query?${params}`)
    return Array.isArray(json.features) ? json.features : []
  } catch (error) {
    if (objectIds.length === 1 && !extraParams.maxAllowableOffset) {
      return queryObjectIds(serviceUrl, objectIds, outFields, {
        ...extraParams,
        maxAllowableOffset: 0.0002,
      })
    }
    if (objectIds.length <= 1) throw error
    const midpoint = Math.ceil(objectIds.length / 2)
    const left = await queryObjectIds(serviceUrl, objectIds.slice(0, midpoint), outFields, extraParams)
    const right = await queryObjectIds(serviceUrl, objectIds.slice(midpoint), outFields, extraParams)
    return [...left, ...right]
  }
}

async function fetchFeatures({ serviceUrl, where = '1=1', outFields, label, pageSize = DEFAULT_PAGE_SIZE }) {
  const objectIds = await fetchObjectIds(serviceUrl, where)
  const features = []
  for (let offset = 0; offset < objectIds.length; offset += pageSize) {
    const page = objectIds.slice(offset, offset + pageSize)
    features.push(...(await queryObjectIds(serviceUrl, page, outFields)))
    console.log(`  ${label}: ${features.length.toLocaleString()} / ${objectIds.length.toLocaleString()}`)
  }
  return { features, expectedCount: objectIds.length }
}

function normalizeCsd(rawFeature) {
  if (!hasPolygonGeometry(rawFeature)) return null
  const source = rawFeature.properties ?? {}
  const uid = String(source.CSDUID ?? '').trim()
  if (!/^\d{7}$/.test(uid)) return null
  const provinceCode = String(source.PRUID ?? uid.slice(0, 2)).trim()
  const cdUid = String(source.CDUID ?? uid.slice(0, 4)).trim()
  const name = String(source.CSDNAME ?? uid).trim() || uid
  return {
    type: 'Feature',
    geometry: rawFeature.geometry,
    properties: {
      id: `statcan:csd:2025:${uid}`,
      boundaryId: `statcan:csd:2025:${uid}`,
      boundaryCode: uid,
      boundaryName: name,
      boundarySource: 'Statistics Canada',
      boundaryLevel: 'census-subdivision',
      referenceDate: '2025-01-01',
      representationRole: 'municipality-or-statistical-equivalent',
      CSDUID: uid,
      CSDNAME: name,
      CSDTYPE: source.CSDTYPE ?? null,
      CDUID: cdUid || uid.slice(0, 4),
      CDNAME: source.CDNAME ?? null,
      CDTYPE: source.CDTYPE ?? null,
      PRUID: provinceCode,
      PRNAME: source.PRNAME ?? PROVINCE_NAMES.get(provinceCode) ?? null,
    },
  }
}

function normalizeCd(rawFeature) {
  if (!hasPolygonGeometry(rawFeature)) return null
  const source = rawFeature.properties ?? {}
  const uid = String(source.CDUID ?? '').trim()
  if (!/^\d{4}$/.test(uid)) return null
  const provinceCode = String(source.PRUID ?? uid.slice(0, 2)).trim()
  const name = String(source.CDNAME ?? uid).trim() || uid
  return {
    type: 'Feature',
    geometry: rawFeature.geometry,
    properties: {
      id: `statcan:cd:2021:${uid}`,
      boundaryId: `statcan:cd:2021:${uid}`,
      boundaryCode: uid,
      boundaryName: name,
      boundarySource: 'Statistics Canada',
      boundaryLevel: 'census-division',
      referenceDate: '2021-01-01',
      representationRole: 'regional-government-or-statistical-equivalent',
      CDUID: uid,
      CDNAME: name,
      CDTYPE: source.CDTYPE ?? null,
      PRUID: provinceCode,
      PRNAME: PROVINCE_NAMES.get(provinceCode) ?? null,
    },
  }
}

function normalizeIndigenousLand(rawFeature) {
  if (!hasPolygonGeometry(rawFeature)) return null
  const source = rawFeature.properties ?? {}
  const adminAreaId = String(source.adminAreaId ?? source.NID ?? rawFeature.id ?? '').trim()
  if (!adminAreaId) return null
  const name = String(source.adminAreaNameEng ?? source.adminAreaNameAlt1 ?? adminAreaId).trim()
  const distributionType = String(source.distributionTypeEng ?? source.distributionType ?? 'Unknown').trim()
  return {
    type: 'Feature',
    geometry: rawFeature.geometry,
    properties: {
      id: `clss:indigenous-land:${adminAreaId}`,
      boundaryId: `clss:indigenous-land:${adminAreaId}`,
      boundaryCode: adminAreaId,
      boundaryName: name,
      boundarySource: 'Natural Resources Canada - Canada Lands Survey System',
      boundaryLevel: 'indigenous-land',
      referenceDate: null,
      representationRole: 'indigenous-land-by-legal-class',
      adminAreaId,
      adminAreaNameEng: source.adminAreaNameEng ?? null,
      adminAreaNameFra: source.adminAreaNameFra ?? null,
      adminAreaNameAlt1: source.adminAreaNameAlt1 ?? null,
      adminAreaNameAltLang1: source.adminAreaNameAltLang1 ?? null,
      distributionType: source.distributionType ?? null,
      distributionTypeEng: distributionType,
      distributionTypeFra: source.distributionTypeFra ?? null,
      adminRegion: source.adminRegion ?? null,
      adminRegionEng: source.adminRegionEng ?? null,
      adminRegionFra: source.adminRegionFra ?? null,
      jurisdiction: source.jurisdiction ?? null,
      jurisdictionEng: source.jurisdictionEng ?? null,
      jurisdictionFra: source.jurisdictionFra ?? null,
      NID: source.NID ?? null,
      representationPurpose: source.representationPurpose ?? null,
      representationPurposeEng: source.representationPurposeEng ?? null,
      representationPurposeFra: source.representationPurposeFra ?? null,
      sourceGeoDB: source.sourceGeoDB ?? null,
      webReference: source.webReference ?? null,
    },
  }
}

async function writeCompressedCollection(outputPath, features) {
  const text = JSON.stringify({ type: 'FeatureCollection', features })
  const compressed = gzipSync(text, { level: 9 })
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, compressed)
  return {
    path: path.relative(OUTPUT_DIR, outputPath),
    features: features.length,
    bbox: featureCollectionBbox(features),
    rawBytes: Buffer.byteLength(text),
    gzipBytes: compressed.byteLength,
    sha256: sha256(compressed),
  }
}

async function readCompressedCollection(inputPath) {
  const buffer = await fs.readFile(inputPath)
  return JSON.parse(gunzipSync(buffer).toString('utf8'))
}

async function resumableFeatures(outputPath, idProperty, normalizer, fetcher) {
  if (resume) {
    try {
      const collection = await readCompressedCollection(outputPath)
      if (collection.type === 'FeatureCollection' && Array.isArray(collection.features)) {
        console.log(`Reusing ${collection.features.length.toLocaleString()} features from ${path.relative(process.cwd(), outputPath)}`)
        return collection.features
      }
    } catch {
      // Fetch below when no valid snapshot exists.
    }
  }
  const { features: rawFeatures, expectedCount } = await fetcher()
  const features = stableFeatureSort(rawFeatures.map(normalizer).filter(Boolean), idProperty)
  if (features.length !== expectedCount) {
    throw new Error(`Normalized ${features.length} features but source advertised ${expectedCount}`)
  }
  return features
}

async function syncCsd() {
  const metadata = await fetchLayerMetadata(STATCAN_CSD_2025)
  const chunks = []
  const allFeatures = []
  for (const [provinceCode, provinceName] of PROVINCES_AND_TERRITORIES) {
    const outputPath = path.join(CSD_DIR, 'provinces', `${provinceCode}.geojson.gz`)
    console.log(`Fetching 2025 CSDs for ${provinceName}...`)
    const features = await resumableFeatures(outputPath, 'CSDUID', normalizeCsd, () =>
      fetchFeatures({
        serviceUrl: STATCAN_CSD_2025,
        where: `PRUID='${provinceCode}'`,
        outFields: 'PRUID,PRNAME,CDUID,CDNAME,CDTYPE,CSDUID,CSDNAME,CSDTYPE',
        label: provinceName,
      }),
    )
    const file = await writeCompressedCollection(outputPath, features)
    chunks.push({ id: provinceCode, name: provinceName, ...file })
    allFeatures.push(...features)
  }
  const manifest = {
    name: 'Statistics Canada 2025 Census Subdivision Boundary File',
    referenceDate: '2025-01-01',
    sourceUrl: STATCAN_CSD_2025,
    licence: 'Statistics Canada Open Licence',
    sourceFeatureCount: Number(metadata.maxRecordCount) ? allFeatures.length : allFeatures.length,
    features: allFeatures.length,
    typeCounts: countBy(allFeatures, 'CSDTYPE'),
    chunks,
  }
  await fs.mkdir(CSD_DIR, { recursive: true })
  await fs.writeFile(path.join(CSD_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

async function syncCd() {
  console.log('Fetching 2021 census divisions...')
  const metadata = await fetchLayerMetadata(STATCAN_CD_2021)
  let features = null
  if (resume) {
    try {
      const chunksManifest = JSON.parse(await fs.readFile(path.join(CD_DIR, 'manifest.json'), 'utf8'))
      const collections = await Promise.all(
        chunksManifest.chunks.map((chunk) => readCompressedCollection(path.join(OUTPUT_DIR, chunk.path))),
      )
      features = collections.flatMap((collection) => collection.features)
      console.log(`Reusing ${features.length.toLocaleString()} census divisions from province/territory shards`)
    } catch {
      try {
        const legacy = await readCompressedCollection(LEGACY_CD_PATH)
        features = legacy.features
        console.log(`Sharding ${features.length.toLocaleString()} census divisions from legacy national snapshot`)
      } catch {
        // Fetch below when no valid completed snapshot exists.
      }
    }
  }
  if (!features) {
    const result = await fetchFeatures({
      serviceUrl: STATCAN_CD_2021,
      outFields: 'CDUID,CDNAME,CDTYPE,PRUID',
      label: 'Census divisions',
      // CD polygons are much larger than their feature count suggests. Small
      // pages avoid ArcGIS response-size timeouts for coastal and northern CDs.
      pageSize: 5,
    })
    features = stableFeatureSort(result.features.map(normalizeCd).filter(Boolean), 'CDUID')
    if (features.length !== result.expectedCount) {
      throw new Error(`Normalized ${features.length} census divisions but source advertised ${result.expectedCount}`)
    }
  }

  const chunks = []
  for (const [provinceCode, provinceName] of PROVINCES_AND_TERRITORIES) {
    const provinceFeatures = features.filter((feature) => feature.properties.PRUID === provinceCode)
    if (provinceFeatures.length === 0) throw new Error(`No census divisions found for ${provinceName}`)
    const outputPath = path.join(CD_DIR, 'provinces', `${provinceCode}.geojson.gz`)
    chunks.push({
      id: provinceCode,
      name: provinceName,
      ...(await writeCompressedCollection(outputPath, provinceFeatures)),
    })
  }
  await fs.mkdir(CD_DIR, { recursive: true })
  const chunksManifest = { features: features.length, chunks }
  await fs.writeFile(path.join(CD_DIR, 'manifest.json'), `${JSON.stringify(chunksManifest, null, 2)}\n`)
  await fs.rm(LEGACY_CD_PATH, { force: true })
  return {
    name: 'Statistics Canada 2021 Cartographic Boundary File - Census Divisions',
    referenceDate: '2021-01-01',
    sourceUrl: STATCAN_CD_2021,
    licence: 'Open Government Licence - Canada',
    advertisedMaxRecordCount: metadata.maxRecordCount ?? null,
    features: features.length,
    typeCounts: countBy(features, 'CDTYPE'),
    chunks,
  }
}

async function syncIndigenousLands() {
  console.log('Fetching CLSS Indigenous land boundaries...')
  const metadata = await fetchLayerMetadata(CLSS_INDIGENOUS_LANDS)
  const features = await resumableFeatures(
    INDIGENOUS_PATH,
    'adminAreaId',
    normalizeIndigenousLand,
    () =>
      fetchFeatures({
        serviceUrl: CLSS_INDIGENOUS_LANDS,
        outFields: [
          'adminAreaId',
          'adminAreaNameEng',
          'adminAreaNameFra',
          'adminAreaNameAlt1',
          'adminAreaNameAltLang1',
          'distributionType',
          'distributionTypeEng',
          'distributionTypeFra',
          'adminRegion',
          'adminRegionEng',
          'adminRegionFra',
          'jurisdiction',
          'jurisdictionEng',
          'jurisdictionFra',
          'NID',
          'representationPurpose',
          'representationPurposeEng',
          'representationPurposeFra',
          'sourceGeoDB',
          'webReference',
        ].join(','),
        label: 'CLSS Indigenous lands',
        pageSize: 100,
      }),
  )
  const file = await writeCompressedCollection(INDIGENOUS_PATH, features)
  return {
    name: 'CLSS Aboriginal Lands of Canada Legislative Boundaries',
    sourceUrl: CLSS_INDIGENOUS_LANDS,
    licence: 'Open Government Licence - Canada',
    referenceDate: null,
    advertisedMaxRecordCount: metadata.maxRecordCount ?? null,
    legalClassCounts: countBy(features, 'distributionTypeEng'),
    ...file,
  }
}

function normalizeNlFeature(rawFeature, kind) {
  if (!hasPolygonGeometry(rawFeature)) return null
  const source = rawFeature.properties ?? {}
  const sourceId = String(source.OBJECTID ?? rawFeature.id ?? source.ID ?? '').trim()
  const agreementAreaId = source.ID == null ? null : String(source.ID)
  if (!sourceId) return null
  const definitions = {
    municipalities: {
      name: String(source.MUNICIPAL_ ?? sourceId).trim(),
      level: 'municipality',
      role: 'local-government',
    },
    labradorInuitLands: {
      name: `Labrador Inuit Lands ${agreementAreaId ?? sourceId}`,
      level: 'indigenous-treaty-land',
      role: 'self-government-or-treaty-land',
    },
    labradorInuitSettlementArea: {
      name: `Labrador Inuit Settlement Area ${agreementAreaId ?? sourceId}`,
      level: 'indigenous-treaty-settlement-area',
      role: 'self-government-or-treaty-land',
    },
  }
  const definition = definitions[kind]
  return {
    type: 'Feature',
    geometry: rawFeature.geometry,
    properties: {
      id: `nl:${kind}:${sourceId}`,
      boundaryId: `nl:${kind}:${sourceId}`,
      boundaryCode: sourceId,
      boundaryName: definition.name,
      boundarySource: 'Government of Newfoundland and Labrador GeoAtlas',
      boundaryLevel: definition.level,
      representationRole: definition.role,
      referenceDate: null,
      sourceFeatureId: sourceId,
      agreementAreaId,
      legalBoundaryUrl: source.MUNICIPAL1 ?? null,
      enablingActUrl: source.MUNICIPA_2 ?? null,
    },
  }
}

async function syncNewfoundlandLabrador() {
  const definitions = [
    { id: 'municipalities', layer: 6, outFields: 'OBJECTID,MUNICIPAL_,MUNICIPAL1,MUNICIPA_2' },
    { id: 'labradorInuitLands', layer: 2, outFields: 'OBJECTID,ID' },
    { id: 'labradorInuitSettlementArea', layer: 3, outFields: 'OBJECTID,ID' },
  ]
  const layers = {}
  for (const definition of definitions) {
    const serviceUrl = `${NL_LAND_USE_SERVICE}/${definition.layer}`
    console.log(`Fetching Newfoundland and Labrador ${definition.id}...`)
    const result = await fetchFeatures({
      serviceUrl,
      outFields: definition.outFields,
      label: `Newfoundland and Labrador ${definition.id}`,
      pageSize: 100,
    })
    const features = stableFeatureSort(
      result.features.map((feature) => normalizeNlFeature(feature, definition.id)).filter(Boolean),
      'sourceFeatureId',
    )
    if (features.length !== result.expectedCount) {
      throw new Error(`${definition.id}: normalized ${features.length} of ${result.expectedCount} features`)
    }
    const outputPath = path.join(
      OUTPUT_DIR,
      'provincial',
      'newfoundland-labrador',
      `${definition.id}.geojson.gz`,
    )
    layers[definition.id] = {
      sourceUrl: serviceUrl,
      licence: 'Government of Newfoundland and Labrador Open Data Licence',
      referenceDate: null,
      ...(await writeCompressedCollection(outputPath, features)),
    }
  }
  return {
    name: 'Newfoundland and Labrador local-government and Labrador Inuit agreement areas',
    layers,
  }
}

async function readExistingManifestEntry(name) {
  try {
    const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'))
    return manifest.datasets?.[name] ?? null
  } catch {
    return null
  }
}

async function fetchText(url, attempt = 1) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'BCDataMapper/CanadaAdministrativeGeographies' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    return response.text()
  } catch (error) {
    if (attempt >= FETCH_RETRIES) throw error
    await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1))
    return fetchText(url, attempt + 1)
  }
}

function parseTypeTable(html) {
  const types = []
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)]
      .map((match) => decodeHtml(match[1]))
    const code = cells[0] ?? ''
    const description = cells[1] ?? ''
    if (!/^[A-ZÉM][A-ZÉM\-]{0,3}$/.test(code) || !description) continue
    types.push({ code, description })
  }
  return types
}

async function syncTypeGlossary() {
  const [csdHtml, cdHtml] = await Promise.all([
    fetchText(STATCAN_CSD_TYPE_TABLE),
    fetchText(STATCAN_CD_TYPE_TABLE),
  ])
  const glossary = {
    schemaVersion: 1,
    referenceDate: '2025-01-01',
    warning: 'A Statistics Canada geography type name does not by itself establish that every feature is a government. Apply a jurisdiction-specific governance-role crosswalk before presenting administrative status.',
    censusSubdivisionTypes: parseTypeTable(csdHtml),
    censusDivisionTypes: parseTypeTable(cdHtml),
    sources: {
      censusSubdivisionTypes: STATCAN_CSD_TYPE_TABLE,
      censusDivisionTypes: STATCAN_CD_TYPE_TABLE,
    },
  }
  if (glossary.censusSubdivisionTypes.length < 50 || glossary.censusDivisionTypes.length < 10) {
    throw new Error('Statistics Canada type glossary was incomplete')
  }
  const outputPath = path.join(OUTPUT_DIR, 'reference', 'statcan-geography-types-2025.json')
  const buffer = Buffer.from(`${JSON.stringify(glossary, null, 2)}\n`)
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, buffer)
  return {
    name: 'Statistics Canada 2025 CSD and CD type glossary',
    referenceDate: '2025-01-01',
    sourceUrls: glossary.sources,
    licence: 'Statistics Canada Open Licence',
    path: path.relative(OUTPUT_DIR, outputPath),
    censusSubdivisionTypes: glossary.censusSubdivisionTypes.length,
    censusDivisionTypes: glossary.censusDivisionTypes.length,
    bytes: buffer.byteLength,
    sha256: sha256(buffer),
  }
}

async function main() {
  await fs.mkdir(path.join(OUTPUT_DIR, 'national'), { recursive: true })
  const datasets = {}
  datasets.censusSubdivisions2025 = skipCsd
    ? await readExistingManifestEntry('censusSubdivisions2025')
    : await syncCsd()
  datasets.censusDivisions2021 = skipCd
    ? await readExistingManifestEntry('censusDivisions2021')
    : await syncCd()
  datasets.indigenousLandsClss = skipIndigenous
    ? await readExistingManifestEntry('indigenousLandsClss')
    : await syncIndigenousLands()
  datasets.statcanTypeGlossary = await syncTypeGlossary()
  datasets.newfoundlandLabrador = skipProvincial
    ? await readExistingManifestEntry('newfoundlandLabrador')
    : await syncNewfoundlandLabrador()

  for (const [name, dataset] of Object.entries(datasets)) {
    if (!dataset) throw new Error(`Missing dataset ${name}; rerun without its --skip flag`)
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    complete: true,
    notes: [
      'Census subdivisions are municipalities or areas treated as municipal equivalents for statistical purposes.',
      'Census divisions are regional governments or statistical equivalents; CD geometry must not be presented as uniformly administrative.',
      'CLSS features retain their legal distribution type and must not be collapsed into a single reserve-land category.',
    ],
    datasets,
  }
  await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote ${path.relative(process.cwd(), MANIFEST_PATH)}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
