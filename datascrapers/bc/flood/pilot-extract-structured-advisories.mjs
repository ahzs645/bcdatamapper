#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..')
const FLOOD_DIR = join(REPO_ROOT, 'datascrapers/bc/flood')
const ADVISORIES_PATHS = [
  join(FLOOD_DIR, 'output/advisories.json'),
  join(REPO_ROOT, 'public/data/flood/advisories.json'),
]

const KNOWN_SECTION_HEADINGS = [
  'Weather Synopsis',
  'River Conditions',
  'Current Conditions',
  'Forecast',
  'Outlook',
  'Definitions',
  'Contact',
  'Links',
]

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    limit: null,
    out: null,
    includeFullText: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--limit') {
      options.limit = Number.parseInt(argv[++i], 10)
    } else if (arg.startsWith('--limit=')) {
      options.limit = Number.parseInt(arg.slice('--limit='.length), 10)
    } else if (arg === '--out') {
      options.out = argv[++i]
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length)
    } else if (arg === '--include-full-text') {
      options.includeFullText = true
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (options.limit !== null && (!Number.isFinite(options.limit) || options.limit < 1)) {
    throw new Error('--limit must be a positive integer')
  }

  return options
}

function printHelp() {
  console.log(`Usage: node datascrapers/bc/flood/pilot-extract-structured-advisories.mjs [options]

Read public/data/flood/advisories.json plus each advisory textPath and extract preliminary
structured narrative fields. By default the JSON report is printed to stdout.

Options:
  --limit <n>             Process only the first n advisories.
  --out <path>            Write report JSON to a local path, for example tmp/flood-advisory-pilot.json.
  --include-full-text     Include normalized full advisory text in each extracted record.
  -h, --help              Show this help.
`)
}

async function firstExistingPath(paths) {
  for (const path of paths) {
    try {
      await access(path)
      return path
    } catch {
      // Try the next consolidation-era or legacy candidate.
    }
  }
  return paths[0]
}

function dataPathCandidatesFromPublicPath(publicPath) {
  if (!publicPath) return []
  const relative = publicPath.replace(/^\/+/, '')
  if (relative.startsWith('data/flood/text/')) {
    return [
      join(FLOOD_DIR, 'archive/text', relative.replace('data/flood/text/', '')),
      join(REPO_ROOT, 'public', relative),
    ]
  }
  if (relative.startsWith('data/flood/raw/')) {
    return [
      join(FLOOD_DIR, 'archive/raw', relative.replace('data/flood/raw/', '')),
      join(REPO_ROOT, 'public', relative),
    ]
  }
  return [join(REPO_ROOT, relative.startsWith('data/') ? `public/${relative}` : relative)]
}

function normalizeWhitespace(value) {
  return value.replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function textLines(text) {
  return normalizeWhitespace(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)))
}

function isBoilerplateChunk(value) {
  return (
    value.length > 900 ||
    /\bSkip to main content\b/i.test(value) ||
    /^Links:\s+Home of River Forecast Centre\b/i.test(value) ||
    /^Levels of Warnings\/Advisories:/i.test(value)
  )
}

function sentenceLikeMatches(text, regex, max = 12) {
  const chunks = normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk && !isBoilerplateChunk(chunk))

  return chunks.filter((chunk) => regex.test(chunk)).slice(0, max)
}

function extractIssuerMinistry(lines) {
  const ministryLine = lines.find((line) => /^Ministry of\b/i.test(line))
  if (ministryLine) return ministryLine.replace(/:$/, '').trim()

  const contactMinistry = lines.find((line) => /\bMinistry of\b/i.test(line))
  const match = contactMinistry?.match(/\bMinistry of\s+.+?(?=\s+Tel:|$)/i)
  return match?.[0]?.replace(/:$/, '').trim() ?? null
}

function extractSectionHeadings(lines) {
  const headings = []
  for (const line of lines) {
    const normalized = line.replace(/\s+/g, ' ').trim()
    const withoutColon = normalized.replace(/:$/, '')
    const wordCount = withoutColon.split(/\s+/).length
    const looksLikeHeading =
      /^[A-Z][A-Za-z /&-]{2,60}:$/.test(normalized) &&
      wordCount <= 5 &&
      !/^(?:The|For example|Details?|Model forecasts?|CLEVER|COFFEE)\b/i.test(withoutColon)

    if (looksLikeHeading) {
      headings.push(normalized.replace(/:$/, ''))
      continue
    }

    const known = KNOWN_SECTION_HEADINGS.find((heading) => normalized.toLowerCase() === `${heading}:`.toLowerCase())
    if (known) headings.push(known)
  }

  const uniqueHeadings = unique(headings)
  const presence = Object.fromEntries(
    KNOWN_SECTION_HEADINGS.map((heading) => [
      heading,
      uniqueHeadings.some((found) => found.toLowerCase() === heading.toLowerCase()),
    ]),
  )

  return { headings: uniqueHeadings, presence }
}

function extractStationIds(text) {
  return unique(text.match(/\b\d{2}[A-Z]{2}\d{3}\b/g) ?? [])
}

function extractAdvisoryLines(lines, title) {
  const advisoryLevel = '(?:Flood Warning|Flood Watch|High Streamflow Advisory)'
  const statusWords = /(ended|maintained|upgraded|downgraded|updated|issued|cancelled|canceled)/i
  const directLineRegex = new RegExp(`\\b${advisoryLevel}\\b.*(?:[–-]|:|for\\b)`, 'i')
  const bulletRegex = /^[•*-]\s+|\u2022\s+/
  const headingRegex = /^[A-Z][A-Za-z /&-]{2,60}:$/
  const linesOut = []

  for (const line of lines) {
    if (isBoilerplateChunk(line)) continue
    if (directLineRegex.test(line) && !/\bmeans that\b/i.test(line)) {
      linesOut.push(line)
    }
  }

  const issuingIndex = lines.findIndex((line) => /\bRiver Forecast Centre is (?:issuing|maintaining|updating|ending)\b/i.test(line))
  if (issuingIndex >= 0) {
    for (const line of lines.slice(issuingIndex + 1, issuingIndex + 20)) {
      if (isBoilerplateChunk(line)) continue
      if (headingRegex.test(line)) break
      if (bulletRegex.test(line) || (/^[A-Z]/.test(line) && !/\bmeans that\b/i.test(line))) {
        linesOut.push(line.replace(bulletRegex, '').trim())
      }
    }
  }

  if (title && directLineRegex.test(title)) linesOut.unshift(title)

  return unique(linesOut).slice(0, 20).map((line) => ({
    line,
    level: line.match(/\b(Flood Warning|Flood Watch|High Streamflow Advisory)\b/i)?.[1] ?? null,
    status: line.match(statusWords)?.[1]?.toLowerCase() ?? null,
  }))
}

function extractFields(advisory, text) {
  const normalizedText = normalizeWhitespace(text)
  const lines = textLines(text)
  const sectionSummary = extractSectionHeadings(lines)
  const returnPeriodRegex = /\b(?:return period|return periods|\d+\s*[- ]?year|1\s*(?:in|:)\s*\d+|annual exceedance probability)\b/i
  const precipitationRegex = /\b(?:precipitation|rainfall|heavy rain|rain-on-snow|snowmelt|freezing levels?|mm\b|millimetres?|atmospheric river)\b/i
  const flowRegex = /\b(?:flows?|streamflow|river levels?|discharge|bankfull|flooding|peak flows?|rising|rise rapidly|m3\/s|m³\/s|cms)\b/i

  return {
    id: advisory.id,
    url: advisory.url,
    title: advisory.title,
    issuedAt: advisory.issuedAt,
    textPath: advisory.textPath,
    issuerMinistry: extractIssuerMinistry(lines),
    sections: sectionSummary,
    returnPeriodMentions: sentenceLikeMatches(normalizedText, returnPeriodRegex),
    precipitationMentions: sentenceLikeMatches(normalizedText, precipitationRegex),
    stationIds: extractStationIds(normalizedText),
    flowMentions: sentenceLikeMatches(normalizedText, flowRegex),
    activeAdvisoryLines: extractAdvisoryLines(lines, advisory.title),
  }
}

function summarize(records, failures) {
  const countWith = (predicate) => records.filter(predicate).length
  const sectionCounts = {}
  for (const record of records) {
    for (const heading of record.sections.headings) {
      sectionCounts[heading] = (sectionCounts[heading] ?? 0) + 1
    }
  }

  return {
    processed: records.length,
    failures: failures.length,
    withIssuerMinistry: countWith((record) => record.issuerMinistry),
    withReturnPeriodMentions: countWith((record) => record.returnPeriodMentions.length > 0),
    withPrecipitationMentions: countWith((record) => record.precipitationMentions.length > 0),
    withStationIds: countWith((record) => record.stationIds.length > 0),
    withFlowMentions: countWith((record) => record.flowMentions.length > 0),
    withActiveAdvisoryLines: countWith((record) => record.activeAdvisoryLines.length > 0),
    sectionCounts: Object.fromEntries(Object.entries(sectionCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  }
}

async function main() {
  const options = parseArgs()
  const advisoriesPath = await firstExistingPath(ADVISORIES_PATHS)
  const advisories = JSON.parse(await readFile(advisoriesPath, 'utf8'))
  const selected = options.limit ? advisories.slice(0, options.limit) : advisories
  const records = []
  const failures = []

  for (const advisory of selected) {
    try {
      const textPath = await firstExistingPath(dataPathCandidatesFromPublicPath(advisory.textPath))
      if (!textPath) throw new Error('Missing textPath')
      const text = await readFile(textPath, 'utf8')
      const extracted = extractFields(advisory, text)
      if (options.includeFullText) extracted.text = normalizeWhitespace(text)
      records.push(extracted)
    } catch (error) {
      failures.push({
        id: advisory.id,
        textPath: advisory.textPath,
        error: error.message,
      })
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    source: {
      advisoriesPath: advisoriesPath.replace(`${REPO_ROOT}/`, ''),
      selected: selected.length,
      totalAvailable: advisories.length,
    },
    summary: summarize(records, failures),
    records,
    failures,
  }

  const json = `${JSON.stringify(report, null, 2)}\n`
  if (options.out) {
    const outPath = resolve(REPO_ROOT, options.out)
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, json)
    console.error(`Wrote pilot extraction report to ${outPath}`)
  } else {
    process.stdout.write(json)
  }
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
