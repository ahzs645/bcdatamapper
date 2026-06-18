#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..')
const FLOOD_DIR = join(REPO_ROOT, 'datascrapers/bc/flood')
const ADVISORIES_PATHS = [
  join(FLOOD_DIR, 'output/advisories.json'),
  join(REPO_ROOT, 'public/data/flood/advisories.json'),
]

function parseArgs(argv = process.argv.slice(2)) {
  const options = { file: null, limit: null, out: null, includeHtml: false }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--file') {
      options.file = argv[++i]
    } else if (arg.startsWith('--file=')) {
      options.file = arg.slice('--file='.length)
    } else if (arg === '--limit') {
      options.limit = Number.parseInt(argv[++i], 10)
    } else if (arg.startsWith('--limit=')) {
      options.limit = Number.parseInt(arg.slice('--limit='.length), 10)
    } else if (arg === '--out') {
      options.out = argv[++i]
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length)
    } else if (arg === '--include-html') {
      options.includeHtml = true
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
  console.log(`Usage: node datascrapers/bc/flood/pilot-clean-legacy-html-advisories.mjs [options]

Extract cleaner line-oriented text from legacy HTML-backed flood advisories.
This is a read-only pilot: it prints or writes a report and does not update archive outputs.

Options:
  --limit <n>      Process only the first n HTML-backed advisories.
  --file <path>    Process one raw .htm/.html file.
  --out <path>     Write report JSON to a local path, for example tmp/flood-html-clean-pilot.json.
  --include-html   Include the extracted content HTML fragment for debugging.
  -h, --help       Show this help.
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

function rawPathCandidates(publicPath) {
  if (!publicPath) return []
  const relative = publicPath.replace(/^\/+/, '')
  if (relative.startsWith('data/flood/raw/')) {
    return [
      join(FLOOD_DIR, 'archive/raw', relative.replace('data/flood/raw/', '')),
      join(REPO_ROOT, 'public', relative),
    ]
  }
  return [join(REPO_ROOT, relative.startsWith('data/') ? `public/${relative}` : relative)]
}

function advisoryIdFromRawName(path) {
  return basename(path)
    .replace(/\.(?:html?|HTML?)$/, '')
    .replace(/-[0-9a-f]{12}$/i, '')
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&ldquo;/gi, '"')
    .replace(/&rdquo;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
}

function extractBetween(value, startRegex, endRegex) {
  const start = value.search(startRegex)
  if (start < 0) return null
  const afterStart = value.slice(start)
  const end = afterStart.search(endRegex)
  return end >= 0 ? afterStart.slice(0, end) : afterStart
}

function extractContentHtml(html) {
  const candidates = [
    extractBetween(html, /<div[^>]+id=["']main-content["'][^>]*>/i, /<div[^>]+id=["']shareIcons["'][^>]*>|<div[^>]+id=["']footer["'][^>]*>/i),
    extractBetween(html, /<!--\s*InstanceBeginEditable\s+name=["']content["']\s*-->/i, /<!--\s*InstanceEndEditable\s*-->/i),
    extractBetween(html, /<div[^>]+id=["']mainColumn["'][^>]*>/i, /<!--\s*InstanceEndEditable\s*-->|<div[^>]+id=["']footer["'][^>]*>/i),
  ]

  return candidates.find((candidate) => candidate && /Flood|Streamflow|River Forecast/i.test(candidate)) ?? html
}

function htmlToLines(html) {
  const withBlocks = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|h[1-6]|div|tr|table|ol|ul)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<sup\b[^>]*>\s*3\s*<\/sup>/gi, '3')
    .replace(/<[^>]+>/g, ' ')

  return decodeEntities(withBlocks)
    .replace(/\uFEFF/g, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .filter((line) => !/^Flood Warnings and Advisories$/i.test(line))
    .filter((line) => !/^Back to page of Flood Warnings and Advisories$/i.test(line))
}

function splitSections(lines) {
  const cutMarkers = [
    /^Contact:/i,
    /^Levels of Warnings\/Advisories:/i,
    /^Links:/i,
    /^A High Streamflow Advisory means/i,
    /^A Flood Watch means/i,
  ]
  const bodyEnd = lines.findIndex((line) => cutMarkers.some((regex) => regex.test(line)))
  const bodyLines = bodyEnd >= 0 ? lines.slice(0, bodyEnd) : lines
  const footerLines = bodyEnd >= 0 ? lines.slice(bodyEnd) : []

  return { bodyLines, footerLines }
}

function extractTitle(lines, fallbackTitle) {
  const titleLines = []
  for (const line of lines.slice(0, 8)) {
    if (/^The (BC )?River Forecast Centre is\b/i.test(line)) break
    if (/^The following Flood Warnings/i.test(line)) break
    if (/^(UPDATED|ISSUED|ENDED|MAINTAINED|DOWNGRADED|UPGRADED)[:\s-]/i.test(line) || /\b(Flood Warning|Flood Watch|High Streamflow Advisory|Streamflow Advisory)\b/i.test(line)) {
      titleLines.push(line)
      continue
    }
    if (titleLines.length > 0 && /(?:AM|PM|\d{4}|May|June|July|October|November|December)/i.test(line)) {
      titleLines.push(line)
    }
  }

  return (titleLines.join(' ').replace(/\s+/g, ' ').trim() || fallbackTitle || null)
}

function extractIssuedText(lines) {
  const dateRegex = /\b(?:ISSUED|UPDATED|Issued|Updated)\s*[:\-\u2013]?\s*(?:\d{1,2}:\d{2}\s*(?:AM|PM)?\s+[A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?|\d{3,4}h\s+[A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?|\d{1,2}[A-Za-z]+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)/i
  return lines.slice(0, 10).map((line) => line.match(dateRegex)?.[0]).find(Boolean) ?? null
}

function titleWithoutIssuedText(title, issuedText) {
  if (!title) return null
  const withoutIssued = issuedText ? title.replace(issuedText, '') : title
  return withoutIssued.replace(/\s+\b(?:ISSUED|UPDATED|Issued|Updated)\s*[:\-\u2013]?\s*$/i, '').replace(/\s+/g, ' ').trim()
}

function extractActiveLines(lines) {
  const active = []
  const leadRegex = /\b(?:is|are)\s+(?:issuing|maintaining|updating|upgrading|downgrading|ending)\b.*\b(Flood Warning|Flood Watch|High Streamflow Advisory)\b/i
  const directRegex = /\b(Flood Warning|Flood Watch|High Streamflow Advisory)\b.*(?:[–-]|:|for\b)/i
  const bodyStartRegex = /^(?:Rain|Rainfall|Rivers?|Temperatures?|A series|Hot temperatures|River levels|Current conditions|The public is advised|A summary of key rivers|The weather|Given the current|Flows? on|Water levels)\b/i

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (leadRegex.test(line)) {
      active.push(line)
      for (const next of lines.slice(i + 1, i + 8)) {
        if (/^(The BC River Forecast Centre|The River Forecast Centre|Contact:|Levels of)/i.test(next) || bodyStartRegex.test(next)) break
        if (/^- /.test(next)) {
          active.push(next)
        }
      }
    } else if (directRegex.test(line) && !/\bmeans that\b/i.test(line)) {
      active.push(line)
    }
  }

  return Array.from(new Set(active)).slice(0, 20)
}

function classifyTemplate(html) {
  if (/id=["']main-content["']/i.test(html)) return 'modern-main-content'
  if (/InstanceBeginEditable\s+name=["']content["']/i.test(html)) return 'legacy-instance-editable'
  if (/id=["']mainColumn["']/i.test(html)) return 'legacy-main-column'
  return 'unknown-html'
}

function cleanLegacyHtml(advisory, html, options) {
  const contentHtml = extractContentHtml(html)
  const lines = htmlToLines(contentHtml)
  const { bodyLines, footerLines } = splitSections(lines)
  const title = extractTitle(bodyLines, advisory.title)
  const issuedText = extractIssuedText(bodyLines)
  const activeLines = extractActiveLines(bodyLines)

  const record = {
    id: advisory.id,
    url: advisory.url,
    rawPath: advisory.rawPath,
    textPath: advisory.textPath,
    template: classifyTemplate(html),
    originalTitle: advisory.title,
    cleanedTitle: title,
    cleanedTitleWithoutIssued: titleWithoutIssuedText(title, issuedText),
    issuedText,
    lineCount: lines.length,
    bodyLineCount: bodyLines.length,
    footerLineCount: footerLines.length,
    activeLines,
    bodyPreview: bodyLines.slice(0, 18),
    footerPreview: footerLines.slice(0, 8),
  }

  if (options.includeHtml) record.contentHtml = contentHtml
  return record
}

function summarize(records, failures) {
  const templates = {}
  for (const record of records) {
    templates[record.template] = (templates[record.template] ?? 0) + 1
  }

  return {
    processed: records.length,
    failures: failures.length,
    withCleanedTitle: records.filter((record) => record.cleanedTitle).length,
    withActiveLines: records.filter((record) => record.activeLines.length > 0).length,
    avgBodyLines: records.length ? Math.round(records.reduce((sum, record) => sum + record.bodyLineCount, 0) / records.length) : 0,
    templates: Object.fromEntries(Object.entries(templates).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  }
}

async function main() {
  const options = parseArgs()
  const advisoriesPath = await firstExistingPath(ADVISORIES_PATHS)
  const advisories = JSON.parse(await readFile(advisoriesPath, 'utf8'))
  const htmlAdvisories = advisories.filter((advisory) => /html?/i.test(advisory.contentType ?? '') || /\.html?$/i.test(advisory.rawPath ?? ''))
  const selected = options.file
    ? [{
        id: advisoryIdFromRawName(options.file),
        url: null,
        rawPath: options.file,
        textPath: null,
        title: null,
      }]
    : options.limit ? htmlAdvisories.slice(0, options.limit) : htmlAdvisories
  const records = []
  const failures = []

  for (const advisory of selected) {
    try {
      const rawPath = options.file ? resolve(process.cwd(), options.file) : await firstExistingPath(rawPathCandidates(advisory.rawPath))
      const html = await readFile(rawPath, 'utf8')
      records.push(cleanLegacyHtml(advisory, html, options))
    } catch (error) {
      failures.push({
        id: advisory.id,
        rawPath: advisory.rawPath,
        error: error.message,
      })
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    source: {
      advisoriesPath: advisoriesPath.replace(`${REPO_ROOT}/`, ''),
      selected: selected.length,
      totalHtmlBacked: htmlAdvisories.length,
      file: options.file,
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
    console.error(`Wrote legacy HTML cleanup report to ${outPath}`)
  } else {
    process.stdout.write(json)
  }
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
