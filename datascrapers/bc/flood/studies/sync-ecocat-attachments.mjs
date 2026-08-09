import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(HERE, 'cache')
const ECOCAT_DIR = join(CACHE_DIR, 'ecocat')
const STUDIES_FILE = join(CACHE_DIR, 'studies.json')
const GIB = 1024 ** 3
const ECOCAT_HOST = 'a100.gov.bc.ca'
const ECOCAT_PATH = '/pub/acat/documents/'

function parseArgs() {
  const options = { download: false, concurrency: 6, maxTotalGib: 18, maxFileGib: 4, minFreeGib: 8 }
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index]
    const next = process.argv[index + 1]
    if (arg === '--download' && next) {
      options.download = next === 'true'
      index += 1
    } else if (arg === '--concurrency' && next) {
      options.concurrency = Number(next)
      index += 1
    } else if (arg === '--max-total-gib' && next) {
      options.maxTotalGib = Number(next)
      index += 1
    } else if (arg === '--max-file-gib' && next) {
      options.maxFileGib = Number(next)
      index += 1
    } else if (arg === '--min-free-gib' && next) {
      options.minFreeGib = Number(next)
      index += 1
    }
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 12) throw new Error('Invalid --concurrency')
  for (const key of ['maxTotalGib', 'maxFileGib', 'minFreeGib']) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`Invalid --${key}`)
  }
  return options
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWithRetry(url, options = {}, attempts = 4) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(120000),
        headers: { 'user-agent': 'bcdatamapper EcoCat local research sync/1.0', ...(options.headers ?? {}) },
        ...options,
      })
      if (response.status >= 500 && attempt < attempts) {
        if (response.body) await response.body.cancel()
        await wait(attempt * 750)
        continue
      }
      return response
    } catch (error) {
      lastError = error
      if (attempt < attempts) await wait(attempt * 750)
    }
  }
  throw lastError
}

function decodeHtml(value) {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\s+/g, ' ')
    .trim()
}

function safeDocumentUrl(value, pageUrl) {
  try {
    const url = new URL(decodeHtml(value), pageUrl)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== ECOCAT_HOST ||
      !url.pathname.startsWith(ECOCAT_PATH) ||
      url.pathname === ECOCAT_PATH ||
      url.pathname.endsWith('/')
    ) return null
    return url.href
  } catch {
    return null
  }
}

function parseAttachments(html, pageUrl) {
  const attachments = []
  const seen = new Set()
  const anchor = /<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match
  while ((match = anchor.exec(html))) {
    const url = safeDocumentUrl(match[1], pageUrl)
    if (!url || seen.has(url)) continue
    seen.add(url)
    attachments.push({ url, label: decodeHtml(match[2]) || basename(new URL(url).pathname) })
  }
  return attachments
}

function localFilename(url) {
  let name
  try {
    name = decodeURIComponent(basename(new URL(url).pathname))
  } catch {
    name = basename(new URL(url).pathname)
  }
  name = name.replace(/[\u0000-\u001f/:\\]/g, '_').replace(/^\.+/, '').trim()
  if (!name) name = createHash('sha256').update(url).digest('hex').slice(0, 20)
  return name
}

function responseSize(response) {
  const total = response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]
  return Number(total || response.headers.get('content-length') || 0) || null
}

async function probe(url) {
  try {
    let response = await fetchWithRetry(url, { method: 'HEAD' }, 2)
    if (response.status === 405 || (response.ok && !response.headers.get('content-length'))) {
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

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
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

async function freeBytes() {
  const filesystem = await statfs(CACHE_DIR)
  return Number(filesystem.bavail) * Number(filesystem.bsize)
}

const options = parseArgs()
await mkdir(ECOCAT_DIR, { recursive: true })
if (!existsSync(STUDIES_FILE)) throw new Error(`Run flood-studies:sync first; missing ${STUDIES_FILE}`)
const studies = JSON.parse(await readFile(STUDIES_FILE, 'utf8'))
const ecoCatStudies = studies.filter((study) => {
  try {
    const url = new URL(study.proponent_report_url)
    return url.hostname === ECOCAT_HOST && url.pathname.includes('/pub/acat/public/viewReport.do')
  } catch {
    return false
  }
})

const collections = await mapConcurrent(ecoCatStudies, Math.min(options.concurrency, 8), async (study) => {
  const response = await fetchWithRetry(study.proponent_report_url)
  if (!response.ok) return { study_id: study.study_id, title: study.report_title, page_url: study.proponent_report_url, page_status: response.status, attachments: [] }
  const html = await response.text()
  const studyDir = join(ECOCAT_DIR, study.study_id)
  await mkdir(join(studyDir, 'documents'), { recursive: true })
  await writeFile(join(studyDir, 'page.html'), html)
  const attachments = parseAttachments(html, response.url).map((attachment) => ({ ...attachment, filename: localFilename(attachment.url) }))
  return { study_id: study.study_id, title: study.report_title, page_url: study.proponent_report_url, final_page_url: response.url, page_status: response.status, attachments }
})

const jobs = collections.flatMap((collection) => collection.attachments.map((attachment) => ({ study_id: collection.study_id, ...attachment })))
const probed = await mapConcurrent(jobs, options.concurrency, async (job, index) => {
  if ((index + 1) % 250 === 0) console.error(`Probed ${index + 1}/${jobs.length}`)
  return { ...job, probe: await probe(job.url) }
})
const uniqueUrls = new Set(probed.map((entry) => entry.url))
const knownTotal = probed.filter((entry) => entry.probe.ok && entry.probe.content_length).reduce((sum, entry) => sum + entry.probe.content_length, 0)
const maxTotalBytes = Math.floor(options.maxTotalGib * GIB)
const maxFileBytes = Math.floor(options.maxFileGib * GIB)
const minFreeBytes = Math.floor(options.minFreeGib * GIB)

let downloadedThisRun = 0
let downloadedBytesThisRun = 0
let cacheBytes = 0
let stoppedForSpace = false
for (const entry of probed) {
  const path = join(ECOCAT_DIR, entry.study_id, 'documents', entry.filename)
  if (existsSync(path)) cacheBytes += (await stat(path)).size
  else if (existsSync(`${path}.part`)) cacheBytes += (await stat(`${path}.part`)).size
}

async function download(entry) {
  if (!options.download || !entry.probe.ok) return { status: options.download ? 'source-unavailable' : 'not-requested' }
  if (entry.probe.content_length && entry.probe.content_length > maxFileBytes) return { status: 'skipped-file-cap' }
  const destination = join(ECOCAT_DIR, entry.study_id, 'documents', entry.filename)
  const partial = `${destination}.part`
  if (existsSync(destination)) {
    const existing = await stat(destination)
    if (!entry.probe.content_length || existing.size === entry.probe.content_length) {
      return { status: 'existing', bytes: existing.size, sha256: await sha256File(destination), local_file: `${entry.study_id}/documents/${entry.filename}` }
    }
  }
  const partialSize = existsSync(partial) ? (await stat(partial)).size : 0
  if (cacheBytes + Math.max(0, (entry.probe.content_length || 0) - partialSize) > maxTotalBytes) return { status: 'skipped-total-cap' }
  if ((await freeBytes()) <= minFreeBytes) {
    stoppedForSpace = true
    return { status: 'skipped-free-space-floor' }
  }
  const headers = partialSize > 0 ? { Range: `bytes=${partialSize}-` } : {}
  const response = await fetchWithRetry(entry.probe.final_url || entry.url, { headers })
  if (!response.ok) {
    if (response.body) await response.body.cancel()
    return { status: `http-${response.status}` }
  }
  const append = partialSize > 0 && response.status === 206
  if (!append && partialSize > 0) {
    await rm(partial, { force: true })
    cacheBytes -= partialSize
  }
  let received = append ? partialSize : 0
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      if (received + chunk.length > maxFileBytes || cacheBytes + chunk.length > maxTotalBytes) return callback(new Error('DOWNLOAD_CAP_EXCEEDED'))
      received += chunk.length
      cacheBytes += chunk.length
      downloadedBytesThisRun += chunk.length
      callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(partial, { flags: append ? 'a' : 'w' }))
    if (entry.probe.content_length && received !== entry.probe.content_length) return { status: 'partial', bytes: received }
    await rename(partial, destination)
    downloadedThisRun += 1
    return { status: 'downloaded', bytes: received, sha256: await sha256File(destination), local_file: `${entry.study_id}/documents/${entry.filename}` }
  } catch (error) {
    if (error.message === 'DOWNLOAD_CAP_EXCEEDED') return { status: 'skipped-cap-during-download', bytes: received }
    return { status: 'download-error', error: error.name || 'Error', bytes: received }
  }
}

let completed = 0
const results = await mapConcurrent(probed, options.concurrency, async (entry) => {
  const result = { ...entry, download: await download(entry) }
  completed += 1
  if (options.download && completed % 50 === 0) {
    console.error(`Processed ${completed}/${probed.length}; downloaded ${downloadedThisRun}; ${(downloadedBytesThisRun / GIB).toFixed(2)} GiB this run`)
  }
  return result
})

for (const collection of collections) {
  const entries = results.filter((entry) => entry.study_id === collection.study_id)
  await writeFile(join(ECOCAT_DIR, collection.study_id, 'manifest.json'), `${JSON.stringify({ ...collection, attachments: entries }, null, 2)}\n`)
}
const statusCounts = {}
for (const entry of results) statusCounts[entry.download.status] = (statusCounts[entry.download.status] || 0) + 1
const manifest = {
  title: 'EcoCat flood-study attachment local research cache',
  redistribution: 'not-authorized-by-flood-study-source-record',
  source: 'https://a100.gov.bc.ca/pub/acat/public/',
  counts: {
    collections: collections.length,
    attachments: results.length,
    unique_urls: uniqueUrls.size,
    source_http_ok: results.filter((entry) => entry.probe.ok).length,
    downloaded_or_existing: results.filter((entry) => ['downloaded', 'existing'].includes(entry.download.status)).length,
  },
  bytes: { known_source_total: knownTotal, cache_total: cacheBytes, downloaded_this_run: downloadedBytesThisRun },
  safeguards: { max_total_gib: options.maxTotalGib, max_file_gib: options.maxFileGib, min_free_gib: options.minFreeGib, stopped_for_space: stoppedForSpace },
  download_statuses: statusCounts,
  collections: collections.map((collection) => ({ study_id: collection.study_id, title: collection.title, page_url: collection.page_url, attachment_count: collection.attachments.length, manifest: `${collection.study_id}/manifest.json` })),
}
await writeFile(join(ECOCAT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(JSON.stringify(manifest, null, 2))
