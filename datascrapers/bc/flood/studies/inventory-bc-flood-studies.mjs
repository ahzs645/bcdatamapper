import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(HERE, 'cache')
const REPORT_DIR = join(CACHE_DIR, 'reports')
const LAYER_URL = 'https://services1.arcgis.com/xeMpV7tU1t4KD3Ei/arcgis/rest/services/Flood_Studies_FGDB_20260331_164628_view/FeatureServer/0'
const CATALOGUE_URL = 'https://catalogue.data.gov.bc.ca/api/3/action/package_show?id=2ca51dd6-cad1-455f-b772-ad770682be09'
const EXPLORER_URL = 'https://climatereadybc.gov.bc.ca/pages/flood-study-explorer'

function parseArgs() {
  const options = { downloadReports: false, maxDownloadMib: 50, concurrency: 4 }
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index]
    const next = process.argv[index + 1]
    if (arg === '--download-reports' && next) {
      options.downloadReports = next === 'true'
      index += 1
    } else if (arg === '--max-download-mib' && next) {
      options.maxDownloadMib = Number(next)
      index += 1
    } else if (arg === '--concurrency' && next) {
      options.concurrency = Number(next)
      index += 1
    }
  }
  if (!Number.isFinite(options.maxDownloadMib) || options.maxDownloadMib <= 0) throw new Error('Invalid --max-download-mib')
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 12) throw new Error('Invalid --concurrency')
  return options
}

async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(60000),
        headers: { 'user-agent': 'bcdatamapper flood-study inventory/1.0', ...(options.headers ?? {}) },
        ...options,
      })
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500))
    }
  }
  throw lastError
}

async function fetchJson(url) {
  const response = await fetchWithRetry(url)
  if (!response.ok) throw new Error(`Request failed ${response.status}: ${url}`)
  const value = await response.json()
  if (value.error) throw new Error(`ArcGIS error: ${JSON.stringify(value.error)}`)
  return value
}

function queryUrl() {
  const url = new URL(`${LAYER_URL}/query`)
  url.search = new URLSearchParams({ where: '1=1', outFields: '*', returnGeometry: 'true', outSR: '4326', f: 'geojson' })
  return url.href
}

function featureBounds(geometry) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity]
  function visit(value) {
    if (!Array.isArray(value)) return
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      bounds[0] = Math.min(bounds[0], value[0])
      bounds[1] = Math.min(bounds[1], value[1])
      bounds[2] = Math.max(bounds[2], value[0])
      bounds[3] = Math.max(bounds[3], value[1])
      return
    }
    for (const child of value) visit(child)
  }
  visit(geometry?.coordinates)
  return bounds.every(Number.isFinite) ? bounds : null
}

function normalizeStudy(feature) {
  const source = feature.properties ?? {}
  const cleanUrl = (value) => {
    const trimmed = String(value || '').trim()
    if (!trimmed) return null
    return trimmed.replace(/^http:/i, 'https:')
  }
  return {
    study_id: source.Project_ID,
    source_object_id: source.OBJECTID,
    proponent: source.Proponent || null,
    consultant: source.Consultant || null,
    report_title: source.Report_Name || null,
    report_date: source.Report_Date || null,
    source_area_sq_m: source.SHAPE__Area ?? null,
    source_boundary_length_m: source.SHAPE__Length ?? null,
    fcl_map_class: source.FCL_Map_has_FCL_or_near_FCL || null,
    proponent_report_url: cleanUrl(source.Proponent_Hosted_Report_URL),
    official_report_package_url: cleanUrl(source.OBJSTR_REPORT),
    official_report_data_package_url: cleanUrl(source.OBJSTR_REPORT_DATA),
    source_report_url_flag: source.ReportURLAvailable || null,
    source_data_url_flag: source.DataURLAvailable || null,
    report_available: source.ReportAvailable === 'Yes',
    bounds_wgs84: featureBounds(feature.geometry),
  }
}

function responseSize(response) {
  const total = response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]
  return Number(total || response.headers.get('content-length') || 0) || null
}

async function probeUrl(url, retryGetOnFailure = false) {
  if (!url) return { status: 'missing-url', ok: false }
  try {
    let response = await fetchWithRetry(url, { method: 'HEAD' }, 2)
    if (response.status === 405 || (retryGetOnFailure && !response.ok) || (!response.headers.get('content-length') && response.ok)) {
      response = await fetchWithRetry(url, { headers: { Range: 'bytes=0-0' } }, 2)
    }
    const result = {
      status: response.status,
      ok: response.ok,
      final_url: response.url,
      content_type: response.headers.get('content-type'),
      content_length: responseSize(response),
      etag: response.headers.get('etag'),
      last_modified: response.headers.get('last-modified'),
    }
    if (response.body) await response.body.cancel()
    return result
  } catch (error) {
    return { status: 'network-error', ok: false, error: error.name || 'Error' }
  }
}

function fileExtension(url, contentType) {
  const type = (contentType || '').toLowerCase()
  if (type.includes('pdf')) return '.pdf'
  if (type.includes('zip')) return '.zip'
  const extension = extname(new URL(url).pathname).toLowerCase()
  return extension === '.pdf' || extension === '.zip' ? extension : null
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function validateFileSignature(path, extension) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(5)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const prefix = buffer.subarray(0, bytesRead)
    const valid = extension === '.pdf'
      ? prefix.toString('ascii').startsWith('%PDF-')
      : prefix[0] === 0x50 && prefix[1] === 0x4b && [0x03, 0x05, 0x07].includes(prefix[2])
    if (!valid) throw new Error(`Invalid ${extension} file signature`)
  } finally {
    await handle.close()
  }
}

async function downloadCapped(url, destination, maxBytes, extension) {
  const response = await fetchWithRetry(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const declaredSize = responseSize(response)
  if (declaredSize && declaredSize > maxBytes) {
    if (response.body) await response.body.cancel()
    return { status: 'skipped-over-cap', content_length: declaredSize }
  }
  const temporary = `${destination}.part`
  let received = 0
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length
      if (received > maxBytes) callback(new Error('DOWNLOAD_CAP_EXCEEDED'))
      else callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(temporary))
    await validateFileSignature(temporary, extension)
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { force: true })
    if (error.message === 'DOWNLOAD_CAP_EXCEEDED') return { status: 'skipped-over-cap', content_length: received }
    throw error
  }
  return { status: 'downloaded', content_length: received, sha256: await sha256File(destination), local_file: `reports/${basename(destination)}` }
}

async function maybeDownloadReport(study, probes, options) {
  if (!options.downloadReports) return { status: 'not-requested' }
  const maxBytes = Math.floor(options.maxDownloadMib * 1024 * 1024)
  const candidates = [
    ['official-package', study.official_report_package_url, probes.official_report],
    ['proponent-hosted', study.proponent_report_url, probes.proponent_report],
  ]
  for (const [source, url, probe] of candidates) {
    if (!url || !probe?.ok) continue
    const extension = fileExtension(probe.final_url || url, probe.content_type)
    if (!extension || (probe.content_length && probe.content_length > maxBytes)) continue
    const destination = join(REPORT_DIR, `${study.study_id}-${source}${extension}`)
    if (existsSync(destination)) {
      const existing = await stat(destination)
      if (!probe.content_length || existing.size === probe.content_length) {
        await validateFileSignature(destination, extension)
        return { status: 'existing', source, content_length: existing.size, sha256: await sha256File(destination), local_file: `reports/${basename(destination)}` }
      }
    }
    try {
      return { source, ...(await downloadCapped(probe.final_url || url, destination, maxBytes, extension)) }
    } catch (error) {
      return { status: 'download-error', source, error: error.message }
    }
  }
  return { status: 'no-downloadable-report-under-cap' }
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length)
  let cursor = 0
  async function worker() {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await mapper(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return results
}

const options = parseArgs()
await mkdir(REPORT_DIR, { recursive: true })
const [layerMetadata, catalogue, geojson] = await Promise.all([fetchJson(`${LAYER_URL}?f=pjson`), fetchJson(CATALOGUE_URL), fetchJson(queryUrl())])
geojson.features.sort((a, b) => String(a.properties?.Project_ID).localeCompare(String(b.properties?.Project_ID)))
const studies = geojson.features.map(normalizeStudy)
if (studies.length === 0 || studies.some((study) => !study.study_id)) throw new Error('Flood study response failed validation')
if (new Set(studies.map((study) => study.study_id)).size !== studies.length) throw new Error('Duplicate Project_ID in flood study response')

const audits = await mapConcurrent(studies, options.concurrency, async (study) => {
  const [officialReport, officialData, proponentReport] = await Promise.all([
    probeUrl(study.official_report_package_url),
    study.source_data_url_flag === 'Yes' ? probeUrl(study.official_report_data_package_url) : Promise.resolve({ status: 'declared-unavailable', ok: false }),
    probeUrl(study.proponent_report_url, true),
  ])
  const probes = { official_report: officialReport, official_data: officialData, proponent_report: proponentReport }
  return { study_id: study.study_id, ...probes, download: await maybeDownloadReport(study, probes, options) }
})

const auditByStudy = new Map(audits.map((audit) => [audit.study_id, audit]))
const normalized = studies.map((study) => ({ ...study, link_audit: auditByStudy.get(study.study_id) }))
const noReachableRoute = normalized.filter((study) => !study.link_audit.proponent_report.ok && !study.link_audit.official_report.ok).map((study) => study.study_id)
const manifest = {
  title: 'BC Flood Study Explorer local research cache',
  redistribution: 'not-authorized-by-source-record',
  license: { title: catalogue.result?.license_title, url: catalogue.result?.license_url },
  source: { explorer_url: EXPLORER_URL, catalogue_url: 'https://catalogue.data.gov.bc.ca/dataset/2ca51dd6-cad1-455f-b772-ad770682be09', arcgis_layer_url: LAYER_URL },
  geometry: {
    crs: 'EPSG:4326',
    simplification: 'none',
    note: 'Source-defined study index areas may overlap and must not be treated as flood extents or watershed partitions.',
    source_metadata_conflict: 'ArcGIS describes total study coverage; the BC Catalogue says records may be mapped from proponent location and may not represent the study location.',
  },
  counts: {
    studies: studies.length,
    polygons: geojson.features.filter((feature) => feature.geometry?.type === 'Polygon').length,
    multipolygons: geojson.features.filter((feature) => feature.geometry?.type === 'MultiPolygon').length,
    fcl: studies.filter((study) => study.fcl_map_class === 'FCL').length,
    near_fcl: studies.filter((study) => study.fcl_map_class === 'Near FCL').length,
    no_fcl: studies.filter((study) => study.fcl_map_class === 'No').length,
    proponent_report_urls: studies.filter((study) => study.proponent_report_url).length,
    proponent_report_urls_http_ok: audits.filter((audit) => audit.proponent_report.ok).length,
    proponent_direct_pdfs_http_ok: audits.filter((audit) => audit.proponent_report.ok && String(audit.proponent_report.content_type).toLowerCase().includes('pdf')).length,
    official_report_packages_http_ok: audits.filter((audit) => audit.official_report.ok).length,
    official_data_packages_http_ok: audits.filter((audit) => audit.official_data.ok).length,
    studies_with_reachable_report_route: studies.length - noReachableRoute.length,
    downloaded_or_existing_reports: audits.filter((audit) => ['downloaded', 'existing'].includes(audit.download.status)).length,
  },
  no_reachable_report_route_study_ids: noReachableRoute,
  report_download: { requested: options.downloadReports, max_download_mib: options.maxDownloadMib },
  layer: { name: layerMetadata.name, object_id_field: layerMetadata.objectIdField, capabilities: layerMetadata.capabilities, fields: layerMetadata.fields?.map(({ name, alias, type }) => ({ name, alias, type })) },
}

await Promise.all([
  writeFile(join(CACHE_DIR, 'studies.geojson'), `${JSON.stringify(geojson)}\n`),
  writeFile(join(CACHE_DIR, 'studies.json'), `${JSON.stringify(normalized, null, 2)}\n`),
  writeFile(join(CACHE_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
  writeFile(join(CACHE_DIR, 'layer-metadata.json'), `${JSON.stringify(layerMetadata, null, 2)}\n`),
  writeFile(join(CACHE_DIR, 'catalogue-metadata.json'), `${JSON.stringify(catalogue.result, null, 2)}\n`),
])
console.log(JSON.stringify(manifest, null, 2))
