import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output')
const RAW_DIR = path.join(OUTPUT_DIR, 'downloads')
const BASE_URL = 'https://communityhealth.phsa.ca'
const USER_AGENT = 'PGMaps bcdatamapper PHSA Community Health scraper'

const GEO_LEVELS = ['BC', 'HA', 'HSDA', 'LHA', 'CHSA', 'CSD', 'SD']
const DEFAULT_DELAY_MS = 350
const DEFAULT_DOWNLOAD_LEVELS = ['LHA', 'CHSA']
const ENVIROSCREEN_KEYWORDS = [
  'chronic obstructive pulmonary disease',
  'copd',
  'hypertension',
  'diabetes',
  'low birth weight',
  'cancer',
  'asthma',
]

const args = parseArgs(process.argv.slice(2))
const delayMs = Number(args.delay ?? DEFAULT_DELAY_MS)
const levels = listArg(args.levels, GEO_LEVELS)
const downloadLevels = listArg(args['download-levels'], DEFAULT_DOWNLOAD_LEVELS)
const mode = String(args.mode ?? 'metadata')
const locationFilter = new Set(listArg(args.locations, []))
const topicFilter = new Set(listArg(args.topics, []))
const keywordFilter = listArg(args.keywords, [])
const overwrite = args.overwrite === 'true'
const downloadAll = args['download-all'] === 'true'
const downloadEnviroScreen = args['download-enviroscreen'] === 'true'
const continueOnError = args['continue-on-error'] !== 'false'

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

function listArg(value, fallback) {
  if (!value) return [...fallback]
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'user-agent': USER_AGENT,
          ...(options.headers ?? {}),
        },
      })
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`)
      }
      return response
    } catch (error) {
      lastError = error
      if (attempt < attempts) await sleep(delayMs * attempt)
    }
  }
  throw lastError
}

function formBody(entries) {
  const params = new URLSearchParams()
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item)
    } else {
      params.append(key, value)
    }
  }
  return params
}

async function postJson(pathname, entries) {
  const response = await fetchWithRetry(`${BASE_URL}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: formBody(entries),
  })
  return response.json()
}

async function postText(pathname, entries) {
  const response = await fetchWithRetry(`${BASE_URL}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: formBody(entries),
  })
  return response.text()
}

function parseIndicatorPayload(payload) {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload
  return Object.entries(parsed).flatMap(([indicatorJson, subIndicators]) => {
    const indicator = JSON.parse(indicatorJson)
    return subIndicators.map((subIndicator) => ({
      topic: indicator.TopicName ?? null,
      indicatorName: indicator.IndicatorName,
      source: indicator.Source,
      sourceDisplayName: indicator.SourceDisplayName,
      indicatorId: indicator.ID,
      subIndicatorName: subIndicator.SubIndecatorName,
      subIndicatorId: subIndicator.ID,
      query: subIndicator.Query ?? null,
      downloadValue: `${subIndicator.SubIndecatorName}.${indicator.Source}`,
    }))
  })
}

function sourceSafe(value) {
  return String(value)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
}

function decodeCsvBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le').replace(/^\uFEFF/, '')
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    throw new Error('Unsupported UTF-16BE CSV response')
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 200))
  const nullByteCount = sample.reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0)
  if (nullByteCount > sample.length / 4) return buffer.toString('utf16le').replace(/^\uFEFF/, '')
  return buffer.toString('utf8').replace(/^\uFEFF/, '')
}

function matchesKeywords(indicator, keywords) {
  if (!keywords.length) return true
  const haystack = `${indicator.indicatorName} ${indicator.subIndicatorName} ${indicator.topic ?? ''}`.toLowerCase()
  return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))
}

async function downloadCsv({ geoLevel, location, topicName, indicators }) {
  const entries = [
    ['GeoLevel', geoLevel],
    ['Location', location.code],
    ['Topic', topicName],
    ['ListSubIndicatorName', indicators.map((indicator) => indicator.downloadValue)],
    ['IsMostRecentYear', 'False'],
    ['SubmitType', 'Download'],
  ]
  const key = (await postText('/GetTheData/SearchByLocationDownload', entries)).trim()
  if (!key || key.startsWith('<')) throw new Error(`Unexpected download key for ${geoLevel}/${location.name}/${topicName}`)

  const response = await fetchWithRetry(`${BASE_URL}/GetTheData/SearchDatabaseDownload?key=${encodeURIComponent(key)}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  return decodeCsvBuffer(buffer)
}

async function buildInventory() {
  await mkdir(OUTPUT_DIR, { recursive: true })

  const inventory = {
    generatedAt: new Date().toISOString(),
    source: BASE_URL,
    endpoints: {
      locations: `${BASE_URL}/GetTheData/GetLocationList`,
      topics: `${BASE_URL}/GetTheData/GetTopicList`,
      indicators: `${BASE_URL}/GetTheData/GetIndicatorList`,
      downloadKey: `${BASE_URL}/GetTheData/SearchByLocationDownload`,
      download: `${BASE_URL}/GetTheData/SearchDatabaseDownload?key=...`,
    },
    levels: [],
  }

  for (const geoLevel of levels) {
    console.log(`PHSA: ${geoLevel} locations/topics/indicators`)
    const locationsRaw = await postJson('/GetTheData/GetLocationList', [['locationType', geoLevel]])
    const locations = locationsRaw
      .map((row) => ({ name: row.Item1, code: String(row.Item2) }))
      .filter((row) => row.code !== '-1' && row.name)
    await sleep(delayMs)

    const topics = await postJson('/GetTheData/GetTopicList', [['locationType', geoLevel]])
    await sleep(delayMs)

    const topicRecords = []
    for (const topic of topics) {
      if (topicFilter.size && !topicFilter.has(topic.TopicName)) continue
      const payload = await postJson('/GetTheData/GetIndicatorList', [
        ['topicName', topic.TopicName],
        ['locationType', geoLevel],
      ])
      const indicators = parseIndicatorPayload(payload).map((indicator) => ({ ...indicator, topic: topic.TopicName }))
      topicRecords.push({
        name: topic.TopicName,
        id: topic.ID,
        indicatorCount: indicators.length,
        sources: [...new Set(indicators.map((indicator) => indicator.sourceDisplayName))].sort(),
        indicators,
      })
      await sleep(delayMs)
    }

    inventory.levels.push({
      geoLevel,
      locationCount: locations.length,
      topicCount: topicRecords.length,
      indicatorCount: topicRecords.reduce((sum, topic) => sum + topic.indicatorCount, 0),
      locations,
      topics: topicRecords,
    })
  }

  await writeFile(path.join(OUTPUT_DIR, 'metadata.json'), `${JSON.stringify(inventory, null, 2)}\n`)
  await writeFile(path.join(OUTPUT_DIR, 'manifest.json'), `${JSON.stringify(toManifest(inventory), null, 2)}\n`)
  return inventory
}

function toManifest(inventory) {
  return {
    generatedAt: inventory.generatedAt,
    source: inventory.source,
    levels: inventory.levels.map((level) => ({
      geoLevel: level.geoLevel,
      locationCount: level.locationCount,
      topicCount: level.topicCount,
      indicatorCount: level.indicatorCount,
      topics: level.topics.map((topic) => ({
        name: topic.name,
        indicatorCount: topic.indicatorCount,
        sources: topic.sources,
      })),
    })),
  }
}

async function writeDownloadPlan(inventory, keywords) {
  const records = []
  for (const level of inventory.levels.filter((entry) => downloadLevels.includes(entry.geoLevel))) {
    for (const location of level.locations) {
      if (locationFilter.size && !locationFilter.has(location.code) && !locationFilter.has(location.name)) continue
      for (const topic of level.topics) {
        const indicators = topic.indicators.filter((indicator) => matchesKeywords(indicator, keywords))
        if (!indicators.length) continue
        records.push({
          geoLevel: level.geoLevel,
          location,
          topic: topic.name,
          indicatorCount: indicators.length,
          indicators: indicators.map((indicator) => ({
            name: indicator.subIndicatorName,
            source: indicator.source,
            downloadValue: indicator.downloadValue,
          })),
        })
      }
    }
  }

  await writeFile(path.join(OUTPUT_DIR, 'download-plan.json'), `${JSON.stringify(records, null, 2)}\n`)
  return records
}

async function runDownloads(inventory, keywords) {
  const plan = await writeDownloadPlan(inventory, keywords)
  await mkdir(RAW_DIR, { recursive: true })
  const results = []

  for (const item of plan) {
    const fileName = `${item.geoLevel}_${sourceSafe(item.location.name || item.location.code)}_${sourceSafe(item.topic)}.csv`
    const outputPath = path.join(RAW_DIR, fileName)
    if (existsSync(outputPath) && !overwrite) {
      console.log(`PHSA: skip existing ${fileName}`)
      results.push({ ...item, output: path.relative(OUTPUT_DIR, outputPath), skipped: true })
      continue
    }

    try {
      console.log(`PHSA: download ${item.geoLevel} ${item.location.name} ${item.topic} (${item.indicatorCount})`)
      const indicators = item.indicators.map((indicator) => ({ downloadValue: indicator.downloadValue }))
      const csv = await downloadCsv({
        geoLevel: item.geoLevel,
        location: item.location,
        topicName: item.topic,
        indicators,
      })
      await writeFile(outputPath, csv)
      results.push({ ...item, output: path.relative(OUTPUT_DIR, outputPath), skipped: false })
      await sleep(delayMs)
    } catch (error) {
      results.push({ ...item, output: path.relative(OUTPUT_DIR, outputPath), skipped: false, error: error.message })
      if (!continueOnError) throw error
      console.warn(`PHSA: failed ${item.geoLevel} ${item.location.name} ${item.topic}: ${error.message}`)
      await sleep(delayMs)
    }
  }

  await writeFile(path.join(OUTPUT_DIR, 'downloads-manifest.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`)
}

async function main() {
  const inventory = await buildInventory()

  if (mode === 'metadata') {
    if (downloadEnviroScreen) await writeDownloadPlan(inventory, keywordFilter.length ? keywordFilter : ENVIROSCREEN_KEYWORDS)
    return
  }

  if (mode === 'download') {
    if (!downloadAll && !downloadEnviroScreen && !keywordFilter.length) {
      throw new Error('Refusing broad download without --download-all true, --download-enviroscreen true, or --keywords.')
    }
    const keywords = downloadAll ? [] : keywordFilter.length ? keywordFilter : ENVIROSCREEN_KEYWORDS
    await runDownloads(inventory, keywords)
    return
  }

  throw new Error(`Unknown mode: ${mode}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
