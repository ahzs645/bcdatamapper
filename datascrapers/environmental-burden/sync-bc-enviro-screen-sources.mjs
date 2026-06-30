import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as turf from '@turf/turf'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output', 'bc-enviro-screen')
const RAW_DIR = path.join(OUTPUT_DIR, 'raw')
const OPENMAPS_WFS_BASE = 'https://openmaps.gov.bc.ca/geo/pub'
const BC_CATALOG_API = 'https://catalogue.data.gov.bc.ca/api/3/action/package_show'
const CANADA_CATALOG_API = 'https://open.canada.ca/data/api/action/package_show'
const USER_AGENT = 'PGMaps BC EnviroScreen source scraper'

const PRINCE_GEORGE_CITY = {
  id: 'city-prince-george',
  label: 'City of Prince George',
  boundaryLayer: 'WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_MUNICIPALITIES_SP',
  boundaryGeometry: 'GEOMETRY',
  boundaryFilter: "ADMIN_AREA_NAME='City of Prince George'",
  bbox: [-122.89936984, 53.8126077, -122.60433309, 54.04174962],
}

const WFS_SOURCES = [
  {
    id: 'bc-environmental-remediation-sites',
    title: 'BC Environmental Remediation Sites',
    packageId: '63804e64-a4f3-4bc7-b1e3-5f736bbc3967',
    layer: 'WHSE_WASTE.SITE_ENV_RMDTN_SITES_SVW',
    geometryProperty: 'GEOMETRY',
    expectedGeometry: 'Point',
    enviroScreenUse: 'Remediation/contaminated-site proximity or density.',
  },
  {
    id: 'bc-wildfire-historical-fire-perimeters',
    title: 'BC Wildfire Fire Perimeters - Historical',
    packageId: '22c7cb44-1463-48f7-8e47-88857f207702',
    layer: 'WHSE_LAND_AND_NATURAL_RESOURCE.PROT_HISTORICAL_FIRE_POLYS_SP',
    geometryProperty: 'SHAPE',
    expectedGeometry: 'Polygon',
    enviroScreenUse: 'Historical burned-area intersection and area summaries.',
  },
  {
    id: 'bc-major-timber-processing-facilities',
    title: 'BC Major Timber Processing Facilities',
    packageId: '67daf53d-e3bb-45ee-9121-8aa1193b7492',
    layer: 'WHSE_IMAGERY_AND_BASE_MAPS.GSR_TMBR_PRCSSING_FAC_SV',
    geometryProperty: 'SHAPE',
    expectedGeometry: 'Point',
    enviroScreenUse: 'Forestry mill proximity or facility counts.',
  },
  {
    id: 'bc-permitted-mine-areas-major-mine',
    title: 'BC Permitted Mine Areas - Major Mine',
    packageId: '01e8a35e-35e3-4b48-93a7-b0d7c9705b62',
    layer: 'WHSE_MINERAL_TENURE.HSP_MJR_MINES_PERMTTD_AREAS_SP',
    geometryProperty: 'SHAPE',
    expectedGeometry: 'Polygon',
    enviroScreenUse: 'Major mine permit-area intersection and area summaries.',
  },
  {
    id: 'bc-oil-and-gas-fields',
    title: 'BC Oil and Gas Fields',
    packageId: '450a1faf-13e0-40c3-9fcf-8864b3714963',
    layer: 'WHSE_MINERAL_TENURE.OG_OIL_AND_GAS_FIELDS_SP',
    geometryProperty: 'GEOMETRY',
    expectedGeometry: 'Polygon',
    enviroScreenUse: 'Oil/gas field intersection and area summaries.',
  },
]

const RAW_SOURCES = [
  {
    id: 'bc-human-disturbance-2025',
    title: 'Human Disturbance - 2025',
    catalog: 'bc',
    packageId: '7d61ff12-b85f-4aeb-ac8b-7b10e84b046c',
    enviroScreenUse: 'Human disturbance footprint area summaries. Source is a FileGDB ZIP, not WFS.',
  },
  {
    id: 'bc-cef-integrated-roads-2026',
    title: 'BC Cumulative Effects Framework - Integrated Roads - 2026',
    catalog: 'bc',
    packageId: 'a489bc6a-f676-4503-8cd7-dcf0bdf2ae99',
    enviroScreenUse: 'Road/linear footprint density. Source is a FileGDB ZIP, not WFS.',
  },
  {
    id: 'bc-ems-results',
    title: 'BC Environmental Monitoring System Results',
    catalog: 'bc',
    packageId: '949f2233-9612-4b06-92a9-903e817da659',
    enviroScreenUse:
      'Water exceedance inputs. Requires streaming EMS result CSVs, QA filtering, parameter-code filters, and guideline/objective joins.',
  },
  {
    id: 'npri-bulk-data',
    title: 'NPRI bulk data files for all years - releases, disposals, transfers and facility locations',
    catalog: 'canada',
    packageId: '40e01423-7728-429c-ac9d-2954385ccdfb',
    enviroScreenUse: 'Industrial release facility locations and pollutant totals; filter to BC/Prince George downstream.',
    directResources: [
      'NPRI-INRP_ReleasesRejets_1993-present.csv',
      'NPRI-INRP_DisposalsEliminations_1993-present.csv',
      'NPRI-INRP_DisposalsEliminations_TransfersTransferts_1993-present.csv',
      'NPRI-INRP_GeolocationsGeolocalisation_1993-present.csv',
      'NPRI-INRP_CommentsCommentaires_1997-present.csv',
    ].map((name) => ({
      name,
      format: 'csv',
      url: `https://data-donnees.az.ec.gc.ca/api/file?path=/substances/plansreports/reporting-facilities-pollutant-release-and-transfer-data/bulk-data-files-for-all-years-releases-disposals-transfers-and-facility-locations/${name}`,
      skipProbe: true,
      notes: 'ECCC api/file streams the CSV and does not expose a reliable cheap Content-Length/range response; size is measured only during intentional download.',
    })),
  },
]

const args = parseArgs(process.argv.slice(2))
const count = Number(args.count ?? 5000)
const includeRawDownloads = args['download-raw'] === 'true'
const overwrite = args.overwrite === 'true'

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = 'true'
    } else {
      parsed[key] = next
      index += 1
    }
  }
  return parsed
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
  if (!response.ok) throw new Error(`Failed ${response.status} ${response.statusText}: ${url}`)
  return response.json()
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
  if (!response.ok) throw new Error(`Failed ${response.status} ${response.statusText}: ${url}`)
  return response.text()
}

function wfsUrl(layer, params = {}) {
  const url = new URL(`${OPENMAPS_WFS_BASE}/${layer}/ows`)
  url.searchParams.set('service', 'WFS')
  url.searchParams.set('version', '2.0.0')
  url.searchParams.set('request', 'GetFeature')
  url.searchParams.set('typeNames', `pub:${layer}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  return url.toString()
}

function packageUrl(catalog, packageId) {
  const url = new URL(catalog === 'canada' ? CANADA_CATALOG_API : BC_CATALOG_API)
  url.searchParams.set('id', packageId)
  return url.toString()
}

async function packageShow(catalog, packageId) {
  const json = await fetchJson(packageUrl(catalog, packageId))
  if (json.success === false) throw new Error(`Catalogue API failed for ${packageId}`)
  return json.result
}

function bboxFilter(source, bbox) {
  return `BBOX(${source.geometryProperty},${bbox.join(',')},'EPSG:4326')`
}

async function fetchBoundary() {
  const json = await fetchJson(
    wfsUrl(PRINCE_GEORGE_CITY.boundaryLayer, {
      outputFormat: 'json',
      srsName: 'EPSG:4326',
      CQL_FILTER: PRINCE_GEORGE_CITY.boundaryFilter,
    }),
  )
  if (!json.features?.length) throw new Error('Prince George boundary returned no features')
  await writeFile(path.join(OUTPUT_DIR, 'city-of-prince-george-boundary.geojson'), `${JSON.stringify(json, null, 2)}\n`)
  return json.features[0]
}

async function wfsHits(source) {
  const text = await fetchText(
    wfsUrl(source.layer, {
      resultType: 'hits',
      CQL_FILTER: bboxFilter(source, PRINCE_GEORGE_CITY.bbox),
    }),
  )
  const matched = text.match(/numberMatched="([^"]+)"/)?.[1]
  return matched && matched !== 'unknown' ? Number(matched) : null
}

async function fetchWfsFeatures(source) {
  const features = []
  let startIndex = 0
  for (;;) {
    const params = {
      outputFormat: 'json',
      srsName: 'EPSG:4326',
      count,
      CQL_FILTER: bboxFilter(source, PRINCE_GEORGE_CITY.bbox),
    }
    if (startIndex > 0) params.startIndex = startIndex
    const json = await fetchJson(
      wfsUrl(source.layer, params),
    )
    features.push(...(json.features ?? []))
    if (!json.features?.length || json.features.length < count) break
    startIndex += count
  }
  return features
}

function filterToBoundary(features, boundaryFeature) {
  return features.filter((feature) => {
    if (!feature.geometry) return false
    const type = feature.geometry.type
    if (type === 'Point') return turf.booleanPointInPolygon(feature, boundaryFeature, { ignoreBoundary: false })
    if (type === 'MultiPoint') {
      return feature.geometry.coordinates.some((coordinate) =>
        turf.booleanPointInPolygon(turf.point(coordinate), boundaryFeature, { ignoreBoundary: false }),
      )
    }
    return turf.booleanIntersects(feature, boundaryFeature)
  })
}

async function syncWfsSource(source, boundaryFeature) {
  console.log(`BC EnviroScreen: WFS ${source.id}`)
  const [pkg, bboxCount, features] = await Promise.all([packageShow('bc', source.packageId), wfsHits(source), fetchWfsFeatures(source)])
  const boundaryFeatures = filterToBoundary(features, boundaryFeature)
  const collection = {
    type: 'FeatureCollection',
    name: source.id,
    bbox: PRINCE_GEORGE_CITY.bbox,
    features: boundaryFeatures.map((feature) => ({
      ...feature,
      properties: {
        ...feature.properties,
        _pgmaps_source_id: source.id,
        _pgmaps_source_title: source.title,
      },
    })),
  }
  const outputFile = `${source.id}.geojson`
  await writeFile(path.join(OUTPUT_DIR, outputFile), `${JSON.stringify(collection)}\n`)
  return {
    ...source,
    catalogUrl: `https://catalogue.data.gov.bc.ca/dataset/${pkg.name ?? source.packageId}`,
    packageTitle: pkg.title,
    bboxFeatureCount: bboxCount,
    princeGeorgeFeatureCount: boundaryFeatures.length,
    output: outputFile,
    wfs: {
      layer: source.layer,
      geometryProperty: source.geometryProperty,
      getCapabilities: `${OPENMAPS_WFS_BASE}/${source.layer}/ows?service=WFS&request=GetCapabilities`,
      geojsonBboxUrl: wfsUrl(source.layer, {
        outputFormat: 'json',
        srsName: 'EPSG:4326',
        CQL_FILTER: bboxFilter(source, PRINCE_GEORGE_CITY.bbox),
      }),
    },
  }
}

function normalizeResource(resource) {
  return {
    id: resource.id,
    name: resource.name,
    format: resource.format,
    url: resource.url || null,
    sizeBytes: Number(resource.size) || null,
    lastModified: resource.last_modified ?? null,
    accessMethod: resource.resource_access_method ?? null,
    storageLocation: resource.resource_storage_location ?? null,
  }
}

async function probeResource(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        range: 'bytes=0-0',
      },
    })
    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      contentType: response.headers.get('content-type'),
      contentLength: Number(response.headers.get('content-length')) || null,
      contentRange: response.headers.get('content-range'),
      lastModified: response.headers.get('last-modified'),
      etag: response.headers.get('etag'),
    }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

function fileNameForResource(source, resource) {
  const extension = String(resource.format || 'bin').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'bin'
  return `${source.id}-${String(resource.name || resource.id).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${extension}`
}

async function downloadRawResource(source, resource) {
  if (!resource.url) return null
  const fileName = fileNameForResource(source, resource)
  const outputPath = path.join(RAW_DIR, fileName)
  if (existsSync(outputPath) && !overwrite) return path.relative(OUTPUT_DIR, outputPath)
  const response = await fetch(resource.url, { redirect: 'follow', headers: { 'user-agent': USER_AGENT } })
  if (!response.ok) throw new Error(`Failed raw download ${response.status}: ${resource.url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(outputPath, buffer)
  return path.relative(OUTPUT_DIR, outputPath)
}

async function syncRawSource(source) {
  console.log(`BC EnviroScreen: raw/catalog ${source.id}`)
  const pkg = await packageShow(source.catalog, source.packageId)
  const resources = (pkg.resources ?? []).map(normalizeResource)
  const dataResources = source.directResources ?? resources.filter((resource) => resource.url && ['fgdb', 'csv', 'zip', 'xlsx'].includes(String(resource.format).toLowerCase()))
  const probed = []
  for (const resource of dataResources) {
    const probe = resource.skipProbe ? { skipped: true, reason: resource.notes } : await probeResource(resource.url)
    const output = includeRawDownloads ? await downloadRawResource(source, resource) : null
    probed.push({ ...resource, probe, output })
  }
  return {
    ...source,
    packageTitle: pkg.title,
    catalogUrl:
      source.catalog === 'canada'
        ? `https://open.canada.ca/data/en/dataset/${source.packageId}`
        : `https://catalogue.data.gov.bc.ca/dataset/${pkg.name ?? source.packageId}`,
    resources,
    dataResources: probed,
  }
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true })
  if (includeRawDownloads) await mkdir(RAW_DIR, { recursive: true })

  const boundaryFeature = await fetchBoundary()
  const wfsSources = []
  for (const source of WFS_SOURCES) {
    wfsSources.push(await syncWfsSource(source, boundaryFeature))
  }

  const rawSources = []
  for (const source of RAW_SOURCES) {
    rawSources.push(await syncRawSource(source))
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    geography: PRINCE_GEORGE_CITY,
    notes: [
      'WFS outputs are bbox-filtered server-side, then filtered against the City of Prince George boundary locally.',
      'Polygon and line geometries are retained whole when they intersect the city; area/length clipping should be done in downstream calculations.',
      'Human Disturbance 2025 and Integrated Roads 2026 are FileGDB ZIP downloads, so downstream processing should use ogr2ogr/GDAL before clipping.',
      'EMS water exceedances require result streaming plus environmental guideline/objective joins; this manifest captures the raw inputs only.',
    ],
    wfsSources,
    rawSources,
  }

  await writeFile(path.join(OUTPUT_DIR, 'metadata.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(path.join(OUTPUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`BC EnviroScreen: wrote ${path.relative(process.cwd(), OUTPUT_DIR)}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
