import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output')
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')
const CATALOG_SUMMARY_PATH = path.join(OUTPUT_DIR, 'source-size-summary.md')

const USER_AGENT = 'PGMaps bcdatamapper environmental burden inventory'
const BC_CATALOG_API = 'https://catalogue.data.gov.bc.ca/api/3/action/package_show'
const CANADA_CATALOG_API = 'https://open.canada.ca/data/api/action/package_show'
const ECCC_FILE_API = 'https://data-donnees.az.ec.gc.ca/api/file'
const ECCC_PATH_CONTENTS_API = 'https://data-donnees.az.ec.gc.ca/api/path_contents'
const OPENMAPS_WFS_BASE = 'https://openmaps.gov.bc.ca/geo/pub'

const NPRI_ECCC_PATH =
  '/substances/plansreports/reporting-facilities-pollutant-release-and-transfer-data/bulk-data-files-for-all-years-releases-disposals-transfers-and-facility-locations'

const EMS_DIRECTORY_URL = 'https://pub.data.gov.bc.ca/datasets/949f2233-9612-4b06-92a9-903e817da659/'

const GROUNDWATER_WELLS_ARCGIS =
  'https://maps.gov.bc.ca/arcgis/rest/services/whse/bcgw_pub_whse_water_management/MapServer/13'

const CATALOG_PACKAGES = [
  {
    id: 'npri-bulk',
    title: 'NPRI releases, disposals, transfers, and facility locations',
    catalog: 'canada',
    packageId: '40e01423-7728-429c-ac9d-2954385ccdfb',
    coverage: 'Canada; filter to BC / Prince George downstream',
    recommendedUse: 'Toxic-release and facility-location scraper.',
    sizeStrategy: 'ecccPathContents',
  },
  {
    id: 'federal-contaminated-sites',
    title: 'Federal Contaminated Sites Inventory',
    catalog: 'canada',
    packageId: '1d42f7b9-1549-40aa-8ac6-0e0302ff2902',
    coverage: 'Canada; filter to BC / Prince George downstream',
    recommendedUse: 'Federal cleanup-site inventory. Parse XML ZIP when host allows download.',
    sizeStrategy: 'catalogAndHttpOnly',
    notes: 'The official ZIP host may reject non-browser probes from this environment; keep size as unknown unless the downloader succeeds.',
  },
  {
    id: 'bc-waste-discharge-authorizations',
    title: 'BC Waste Discharge Authorizations',
    catalog: 'bc',
    packageId: 'waste-discharge-authorizations-all-authorizations',
    relatedPackages: ['waste-discharge-authorizations-all-discharges'],
    coverage: 'British Columbia',
    recommendedUse: 'Industrial/waste authorization proxy; direct XLSX resources are small enough to poll.',
    sizeStrategy: 'downloadSmallResources',
  },
  {
    id: 'bc-groundwater-wells',
    title: 'BC groundwater wells and observation-well levels',
    catalog: 'bc',
    packageId: 'groundwater-wells',
    relatedPackages: ['provincial-groundwater-observation-well-network-groundwater-levels-data'],
    coverage: 'British Columbia',
    recommendedUse: 'Groundwater well density/proximity and observation-well trend context.',
    sizeStrategy: 'arcgisCountEstimateAndCsvHeads',
  },
  {
    id: 'bc-ems-enmods-water-quality',
    title: 'BC EMS / EnMoDS water quality results and locations',
    catalog: 'bc',
    packageId: 'bc-environmental-monitoring-system-results',
    relatedPackages: [
      'bc-environmental-monitoring-data-system-results',
      'environmental-monitoring-data-system-enmods-spatial-sampling-locations',
    ],
    coverage: 'British Columbia',
    recommendedUse: 'Ambient water quality result scraper; derive exceedances against objectives/guidelines downstream.',
    sizeStrategy: 'emsDirectoryAndEnmodsRange',
    notes: 'EMS is historical/legacy; EnMoDS is the current source family.',
  },
  {
    id: 'bc-water-quality-objectives',
    title: 'BC Water Quality Objectives Reports - Index',
    catalog: 'bc',
    packageId: 'water-quality-objectives-reports-index',
    coverage: 'British Columbia',
    recommendedUse: 'Spatial report index and objective-document links for exceedance logic.',
    sizeStrategy: 'wfsCountAndGeojsonSize',
    wfsTypeName: 'WHSE_WATER_MANAGEMENT.WQ_WQO_RPT_INDEX_SP',
  },
  {
    id: 'bc-historical-floodplains',
    title: 'Mapped Floodplains in BC (Historical)',
    catalog: 'bc',
    packageId: 'mapped-floodplains-in-bc-historical',
    coverage: 'British Columbia',
    recommendedUse: 'Historical floodplain polygon burden/exposure layer.',
    sizeStrategy: 'wfsCountAndGeojsonSize',
    wfsTypeName: 'WHSE_BASEMAPPING.CWB_FLOODPLAINS_BC_AREA_SVW',
  },
]

const ENMODS_OBJECTS = [
  {
    id: 'enmods-current-results',
    label: 'Current EnMoDS Results - last two years',
    url: 'https://coms.api.gov.bc.ca/api/v1/object/84ed1220-bd51-40a8-9f29-d916144e2dfe',
  },
  {
    id: 'enmods-previous-2-to-5-years',
    label: 'EnMoDS Sample Results - previous 2-5 years',
    url: 'https://coms.api.gov.bc.ca/api/v1/object/6edecb56-d06a-4b2e-9ab0-48584eba3df0',
  },
  {
    id: 'enmods-previous-5-to-10-years',
    label: 'EnMoDS Sample Results - previous 5-10 years',
    url: 'https://coms.api.gov.bc.ca/api/v1/object/55e77e5a-ea9d-41e3-ab98-473fafabb0d6',
  },
  {
    id: 'enmods-historic-results',
    label: 'EnMoDS Sample Results - historic older than 10 years',
    url: 'https://coms.api.gov.bc.ca/api/v1/object/d88adc20-297e-4585-8de9-76a6342dd8e7',
  },
  {
    id: 'enmods-sampling-locations-csv',
    label: 'EnMoDS Sampling Locations CSV',
    url: 'https://coms.api.gov.bc.ca/api/v1/object/e4e1829d-c1a1-4932-b275-de6e423a6d71',
  },
  {
    id: 'enmods-sampling-locations-gpkg',
    label: 'EnMoDS Sampling Locations GeoPackage',
    url: 'https://coms.api.gov.bc.ca/api/v1/object/cf9aa27e-e5fa-48a6-b4c8-30146e1fc95e',
  },
]

const NON_FILE_RESOURCE_FORMATS = new Set(['html', 'other', 'wms', 'arcgis_rest', 'multiple'])

function catalogUrl(catalog, packageId) {
  const base = catalog === 'bc' ? BC_CATALOG_API : CANADA_CATALOG_API
  const url = new URL(base)
  url.searchParams.set('id', packageId)
  return url.toString()
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
  if (!response.ok) throw new Error(`Failed to fetch JSON ${response.status}: ${url}`)
  const json = await response.json()
  if (json.success === false) throw new Error(`Catalogue API failed: ${url}`)
  return json
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
  if (!response.ok) throw new Error(`Failed to fetch text ${response.status}: ${url}`)
  return response.text()
}

async function packageShow(catalog, packageId) {
  const json = await fetchJson(catalogUrl(catalog, packageId))
  return json.result
}

function normalizeResources(pkg) {
  return (pkg.resources ?? []).map((resource) => ({
    id: resource.id,
    name: resource.name,
    format: resource.format,
    url: resource.url || null,
    catalogueSizeBytes: numericSize(resource.size),
    lastModified: resource.last_modified ?? null,
    resourceType: resource.resource_type ?? null,
  }))
}

function numericSize(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function parseSizeLabel(label) {
  if (!label) return null
  const match = String(label).trim().match(/^([\d.]+)\s*([KMGT]?i?B?|B)$/i)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  const unit = match[2].toLowerCase()
  const multipliers = {
    b: 1,
    kb: 1000,
    k: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    m: 1000 ** 2,
    mib: 1024 ** 2,
    gb: 1000 ** 3,
    g: 1000 ** 3,
    gib: 1024 ** 3,
    tb: 1000 ** 4,
    t: 1000 ** 4,
    tib: 1024 ** 4,
  }
  return Math.round(value * (multipliers[unit] ?? 1))
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return null
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000
    unitIndex += 1
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`
}

function summarizeBytes(resources) {
  const bytes = resources
    .map((resource) => resource.sizeBytes ?? resource.catalogueSizeBytes ?? resource.estimatedBytes ?? null)
    .filter((value) => Number.isFinite(value))
  if (!bytes.length) return null
  return bytes.reduce((sum, value) => sum + value, 0)
}

function sumResources(resources, predicate) {
  return resources
    .filter(predicate)
    .map((resource) => resource.sizeBytes ?? resource.catalogueSizeBytes ?? resource.estimatedBytes ?? null)
    .filter((value) => Number.isFinite(value))
    .reduce((sum, value) => sum + value, 0)
}

async function probeHead(url) {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT },
    })
    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      contentLength: numericSize(response.headers.get('content-length')),
      contentType: response.headers.get('content-type'),
      lastModified: response.headers.get('last-modified'),
      note: response.ok ? null : 'HEAD probe did not return a successful status.',
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      finalUrl: url,
      contentLength: null,
      contentType: null,
      lastModified: null,
      note: error.message,
    }
  }
}

async function probeRangeSize(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        range: 'bytes=0-0',
      },
      redirect: 'follow',
    })
    const contentRange = response.headers.get('content-range')
    const match = contentRange?.match(/\/(\d+)$/)
    return {
      ok: response.ok,
      status: response.status,
      finalUrl: stripSignedQuery(response.url),
      contentRange,
      contentLength: match ? Number(match[1]) : numericSize(response.headers.get('content-length')),
      contentType: response.headers.get('content-type'),
      lastModified: response.headers.get('last-modified'),
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      finalUrl: url,
      contentRange: null,
      contentLength: null,
      contentType: null,
      lastModified: null,
      note: error.message,
    }
  }
}

function stripSignedQuery(url) {
  if (!url) return url
  if (!url.includes('?')) return url
  return `${url.split('?')[0]}?...`
}

async function countDownloadBytes(url, maxBytes = 80_000_000) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      finalUrl: response.url,
      contentLength: null,
      contentType: response.headers.get('content-type'),
      note: `GET probe failed with ${response.status}.`,
    }
  }

  const declaredLength = numericSize(response.headers.get('content-length'))
  if (declaredLength && declaredLength > maxBytes) {
    return {
      ok: true,
      status: response.status,
      finalUrl: response.url,
      contentLength: declaredLength,
      contentType: response.headers.get('content-type'),
      lastModified: response.headers.get('last-modified'),
      note: 'Used Content-Length; body was not downloaded.',
    }
  }

  const reader = response.body?.getReader()
  if (!reader) {
    return {
      ok: false,
      status: response.status,
      finalUrl: response.url,
      contentLength: null,
      contentType: response.headers.get('content-type'),
      note: 'Response did not expose a readable body.',
    }
  }

  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return {
        ok: true,
        status: response.status,
        finalUrl: response.url,
        contentLength: null,
        contentType: response.headers.get('content-type'),
        lastModified: response.headers.get('last-modified'),
        note: `Probe exceeded ${humanBytes(maxBytes)}; size not counted fully.`,
      }
    }
  }

  return {
    ok: true,
    status: response.status,
    finalUrl: response.url,
    contentLength: total,
    contentType: response.headers.get('content-type'),
    lastModified: response.headers.get('last-modified'),
    note: 'Counted response bytes from a safe GET probe.',
  }
}

function ecccDownloadUrl(pathName) {
  const url = new URL(ECCC_FILE_API)
  url.searchParams.set('path', `/${pathName}`)
  return url.toString()
}

async function getNpriResourcesFromEccc() {
  const url = new URL(ECCC_PATH_CONTENTS_API)
  url.searchParams.set('path', NPRI_ECCC_PATH)
  const listing = await fetchJson(url.toString())
  return (listing.path_contents ?? [])
    .filter((entry) => !entry.is_directory && entry.name.endsWith('.csv'))
    .map((entry) => ({
      id: entry.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: entry.name,
      format: 'CSV',
      url: ecccDownloadUrl(entry.path),
      sizeBytes: parseSizeLabel(entry.content_length),
      sizeLabel: entry.content_length,
      lastModified: entry.last_modified,
      probe: {
        source: 'ECCC path_contents API',
        path: entry.path,
      },
    }))
}

async function getEmsDirectoryResources() {
  const html = await fetchText(EMS_DIRECTORY_URL)
  const resources = []
  const linePattern = /<a href="([^"]+)">([^<]+)<\/a>\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+([0-9.]+[KMGTP]?)/gi
  let match
  while ((match = linePattern.exec(html))) {
    const [, href, label, modified, sizeLabel] = match
    if (!href.endsWith('.csv') && !href.endsWith('.zip')) continue
    resources.push({
      id: href.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: href,
      label: label.replace(/&gt;/g, '>'),
      format: href.endsWith('.zip') ? 'ZIP' : 'CSV',
      url: new URL(href, EMS_DIRECTORY_URL).toString(),
      sizeBytes: parseSizeLabel(sizeLabel),
      sizeLabel,
      lastModified: modified,
      probe: {
        source: 'BC pub.data.gov.bc.ca Apache directory index',
      },
    })
  }
  return resources.sort((a, b) => a.name.localeCompare(b.name))
}

async function getWfsCount(typeName) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '1.1.0',
    request: 'GetFeature',
    typeName: `pub:${typeName}`,
    resultType: 'hits',
  })
  const text = await fetchText(`${OPENMAPS_WFS_BASE}/${typeName}/ows?${params.toString()}`)
  const match = text.match(/numberOfFeatures="([^"]+)"/) ?? text.match(/numberMatched="([^"]+)"/)
  return match ? Number(match[1]) : null
}

function wfsGeojsonUrl(typeName) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '1.0.0',
    request: 'GetFeature',
    typeName: `pub:${typeName}`,
    outputFormat: 'json',
    srsName: 'EPSG:4326',
  })
  return `${OPENMAPS_WFS_BASE}/${typeName}/ows?${params.toString()}`
}

async function getArcgisCount(layerUrl, where = '1=1') {
  const url = new URL(`${layerUrl}/query`)
  url.searchParams.set('where', where)
  url.searchParams.set('returnCountOnly', 'true')
  url.searchParams.set('f', 'json')
  const json = await fetchJson(url.toString())
  return Number(json.count)
}

async function getArcgisSampleEstimate(layerUrl, count) {
  const sampleSize = 1000
  const url = new URL(`${layerUrl}/query`)
  url.searchParams.set('where', '1=1')
  url.searchParams.set('outFields', '*')
  url.searchParams.set('returnGeometry', 'true')
  url.searchParams.set('outSR', '4326')
  url.searchParams.set('f', 'geojson')
  url.searchParams.set('resultRecordCount', String(sampleSize))
  url.searchParams.set('resultOffset', '0')
  const text = await fetchText(url.toString())
  const featureCount = JSON.parse(text).features?.length ?? sampleSize
  const bytesPerFeature = text.length / Math.max(featureCount, 1)
  return {
    sampleFeatureCount: featureCount,
    sampleBytes: Buffer.byteLength(text),
    estimatedBytes: Math.round(bytesPerFeature * count),
    method: 'Estimated from first ArcGIS GeoJSON page with all fields and geometry.',
  }
}

function isDownloadableFile(resource) {
  const format = String(resource.format ?? '').toLowerCase()
  if (!resource.url) return false
  return !NON_FILE_RESOURCE_FORMATS.has(format)
}

async function buildDataset(source) {
  const packages = [source.packageId, ...(source.relatedPackages ?? [])]
  const packageResults = []
  for (const packageId of packages) {
    const pkg = await packageShow(source.catalog, packageId)
    packageResults.push({
      id: pkg.id,
      name: pkg.name,
      title: pkg.title,
      license: pkg.license_title,
      metadataModified: pkg.metadata_modified,
      catalogueUrl:
        source.catalog === 'bc'
          ? `https://catalogue.data.gov.bc.ca/dataset/${pkg.name}`
          : `https://open.canada.ca/data/en/dataset/${pkg.id}`,
      resources: normalizeResources(pkg),
    })
  }

  let resources = packageResults.flatMap((pkg) =>
    pkg.resources.map((resource) => ({
      ...resource,
      packageId: pkg.id,
      packageTitle: pkg.title,
    })),
  )
  const probes = {}
  let recordCount = null
  let estimatedBytes = null
  let sizeNote = null

  if (source.sizeStrategy === 'ecccPathContents') {
    resources = await getNpriResourcesFromEccc()
  } else if (source.sizeStrategy === 'downloadSmallResources') {
    const probed = []
    for (const resource of resources) {
      if (!isDownloadableFile(resource)) {
        probed.push(resource)
        continue
      }
      const probe = await countDownloadBytes(resource.url, 10_000_000)
      probed.push({
        ...resource,
        sizeBytes: probe.contentLength,
        probe,
      })
    }
    resources = probed
  } else if (source.sizeStrategy === 'arcgisCountEstimateAndCsvHeads') {
    const totalWells = await getArcgisCount(GROUNDWATER_WELLS_ARCGIS)
    const observationWells = await getArcgisCount(
      GROUNDWATER_WELLS_ARCGIS,
      "OBSERVATION_WELL_STATUS IN ('Active','Inactive')",
    )
    const sampleEstimate = await getArcgisSampleEstimate(GROUNDWATER_WELLS_ARCGIS, totalWells)
    probes.arcgis = {
      layerUrl: GROUNDWATER_WELLS_ARCGIS,
      totalWells,
      observationWells,
      sampleEstimate,
    }
    recordCount = totalWells
    estimatedBytes = sampleEstimate.estimatedBytes

    const probed = []
    for (const resource of resources) {
      if (isDownloadableFile(resource)) {
        const probe = await probeHead(resource.url)
        probed.push({ ...resource, sizeBytes: probe.contentLength, probe })
      } else {
        probed.push(resource)
      }
    }
    resources = probed
  } else if (source.sizeStrategy === 'emsDirectoryAndEnmodsRange') {
    const emsResources = await getEmsDirectoryResources()
    const enmodsResources = []
    for (const object of ENMODS_OBJECTS) {
      const probe = await probeRangeSize(object.url)
      enmodsResources.push({
        id: object.id,
        name: object.label,
        format: object.id.includes('gpkg') ? 'GPKG' : object.id.includes('locations') ? 'CSV' : 'CSV.GZ',
        url: object.url,
        sizeBytes: probe.contentLength,
        lastModified: probe.lastModified,
        probe,
      })
    }
    resources = [...emsResources, ...enmodsResources]
  } else if (source.sizeStrategy === 'wfsCountAndGeojsonSize') {
    recordCount = await getWfsCount(source.wfsTypeName)
    const geojsonUrl = wfsGeojsonUrl(source.wfsTypeName)
    const probe = await countDownloadBytes(geojsonUrl, 80_000_000)
    probes.wfs = {
      typeName: source.wfsTypeName,
      recordCount,
      geojsonUrl,
      geojsonBytes: probe.contentLength,
      probe,
    }
    resources.push({
      id: `${source.id}-wfs-geojson`,
      name: `${source.wfsTypeName} WFS GeoJSON`,
      format: 'GeoJSON',
      url: geojsonUrl,
      sizeBytes: probe.contentLength,
      probe,
    })
  } else if (source.sizeStrategy === 'catalogAndHttpOnly') {
    const probed = []
    for (const resource of resources) {
      if (!isDownloadableFile(resource)) {
        probed.push(resource)
        continue
      }
      const probe = await probeHead(resource.url)
      probed.push({
        ...resource,
        sizeBytes: probe.contentLength,
        probe,
      })
    }
    resources = probed
    if (resources.every((resource) => !resource.sizeBytes && !resource.catalogueSizeBytes)) {
      sizeNote = 'No byte size exposed by the catalogue/API from this environment.'
    }
  }

  const knownBytes = summarizeBytes(resources)
  const totalBytes = knownBytes && estimatedBytes ? knownBytes + estimatedBytes : knownBytes ?? estimatedBytes
  const sizeSummary = buildSizeSummary(source, resources, {
    knownBytes,
    estimatedBytes,
    totalBytes,
    probes,
  })

  return {
    id: source.id,
    title: source.title,
    coverage: source.coverage,
    recommendedUse: source.recommendedUse,
    notes: source.notes ?? null,
    packages: packageResults.map(({ resources: _resources, ...pkg }) => pkg),
    recordCount,
    knownBytes,
    estimatedBytes,
    totalBytes,
    sizeLabel: humanBytes(totalBytes),
    sizeSummary,
    sizeNote,
    probes,
    resources: resources.map((resource) => ({
      ...resource,
      sizeLabel: humanBytes(resource.sizeBytes ?? resource.catalogueSizeBytes ?? resource.estimatedBytes),
    })),
  }
}

function buildSizeSummary(source, resources, summary) {
  if (source.id === 'federal-contaminated-sites') {
    const supportBytes = sumResources(resources, (resource) => resource.sizeBytes || resource.catalogueSizeBytes)
    return `Unknown data ZIP; ${humanBytes(supportBytes)} support files`
  }

  if (source.id === 'bc-groundwater-wells') {
    const csvBytes = summary.knownBytes ?? 0
    const spatialBytes = summary.estimatedBytes ?? null
    if (spatialBytes) {
      return `${humanBytes(csvBytes)} CSV + ~${humanBytes(spatialBytes)} spatial estimate = ~${humanBytes(csvBytes + spatialBytes)}`
    }
  }

  if (source.id === 'bc-ems-enmods-water-quality') {
    const emsRawBytes = sumResources(
      resources,
      (resource) => resource.name?.startsWith('ems_') && resource.name.endsWith('.csv'),
    )
    const emsZipBytes = sumResources(
      resources,
      (resource) => resource.name?.startsWith('ems_') && resource.name.endsWith('.zip'),
    )
    const enmodsBytes = sumResources(resources, (resource) => resource.id?.startsWith('enmods-'))
    return `EnMoDS ${humanBytes(enmodsBytes)}; EMS raw CSV alternatives ${humanBytes(emsRawBytes)} / zipped alternatives ${humanBytes(emsZipBytes)}`
  }

  return humanBytes(summary.totalBytes)
}

function markdownSummary(manifest) {
  const rows = manifest.datasets.map((dataset) => [
    dataset.title,
    dataset.sizeSummary ?? dataset.sizeLabel ?? 'Unknown',
    dataset.recordCount ?? dataset.probes?.arcgis?.totalWells ?? '',
    dataset.notes ?? dataset.sizeNote ?? '',
  ])

  const lines = [
    '# Environmental Burden Source Size Summary',
    '',
    `Generated: ${manifest.generatedAt}`,
    '',
    '| Dataset | Size / estimate | Records/features | Notes |',
    '| --- | ---: | ---: | --- |',
    ...rows.map((row) => `| ${row.map((cell) => String(cell).replaceAll('|', '\\|')).join(' | ')} |`),
    '',
    'Byte sizes are raw source-download sizes where the upstream exposes them. WFS/ArcGIS rows use live service counts and, for large groundwater wells, a sampled GeoJSON-size estimate rather than a full download.',
    '',
  ]
  return `${lines.join('\n')}`
}

async function main() {
  const datasets = []
  for (const source of CATALOG_PACKAGES) {
    console.log(`Probing ${source.id}...`)
    datasets.push(await buildDataset(source))
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    title: 'Environmental burden source inventory',
    description:
      'Source inventory and size probes for candidate CalEnviroScreen/BCEnviroScreen burden scrapers. This is intentionally not a bulk download.',
    datasets,
  }

  await mkdir(OUTPUT_DIR, { recursive: true })
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(CATALOG_SUMMARY_PATH, markdownSummary(manifest))

  console.log(`Wrote ${MANIFEST_PATH}`)
  console.log(`Wrote ${CATALOG_SUMMARY_PATH}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
