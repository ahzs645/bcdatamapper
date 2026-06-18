#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..')
const FLOOD_DIR = join(REPO_ROOT, 'datascrapers/bc/flood')
const RAW_EXTRACT_DIR = join(REPO_ROOT, 'tmp/flood-raw/raw')
const execFileAsync = promisify(execFile)
const ADVISORIES_PATHS = [
  join(FLOOD_DIR, 'output/advisories.json'),
  join(REPO_ROOT, 'public/data/flood/advisories.json'),
]

const LEVEL = '(?:Flood Warning|Flood Watch|High Streamflow Advisory)'
const STATUS_FROM_ACTION = {
  issuing: 'issued',
  issued: 'issued',
  new: 'issued',
  maintaining: 'maintained',
  maintained: 'maintained',
  maintain: 'maintained',
  updating: 'updated',
  updated: 'updated',
  update: 'updated',
  upgrading: 'upgraded',
  upgraded: 'upgraded',
  upgrade: 'upgraded',
  downgrading: 'downgraded',
  downgraded: 'downgraded',
  downgrade: 'downgraded',
  ending: 'ended',
  ended: 'ended',
  cancelled: 'cancelled',
  canceled: 'cancelled',
}
const FILENAME_ACTIONS = {
  iss: 'issued',
  issu: 'issued',
  upd: 'updated',
  update: 'updated',
  upg: 'upgraded',
  upgr: 'upgraded',
  dwn: 'downgraded',
  dng: 'downgraded',
  dgd: 'downgraded',
  mai: 'maintained',
  main: 'maintained',
  end: 'ended',
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { limit: null, out: null, includeLines: false }
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
    } else if (arg === '--include-lines') {
      options.includeLines = true
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
  console.log(`Usage: node datascrapers/bc/flood/build-structured-advisories-pilot.mjs [options]

Build a read-only structured flood advisory pilot from output/advisories.json plus extracted raw files.
The report is printed to stdout unless --out is provided. Existing output files are not modified.

Options:
  --limit <n>       Process only the first n advisories.
  --out <path>      Write report JSON to a local path, for example tmp/flood-structured-pilot.json.
  --include-lines   Include normalized source lines in each record for debugging.
  -h, --help        Show this help.
`)
}

async function firstExistingPath(paths) {
  for (const path of paths) {
    try {
      await access(path)
      return path
    } catch {
      // Try next consolidation-era or legacy candidate.
    }
  }
  return paths[0]
}

async function existingPath(paths) {
  for (const path of paths) {
    try {
      await access(path)
      return path
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

function publicPathCandidates(publicPath, kind) {
  if (!publicPath) return []
  const relative = publicPath.replace(/^\/+/, '')
  if (kind === 'text' && relative.startsWith('data/flood/text/')) {
    return [join(REPO_ROOT, 'public', relative)]
  }
  if (kind === 'raw' && relative.startsWith('data/flood/raw/')) {
    const filename = relative.replace('data/flood/raw/', '')
    return [
      join(FLOOD_DIR, 'archive/raw', filename),
      join(RAW_EXTRACT_DIR, filename),
      join(REPO_ROOT, 'public', relative),
    ]
  }
  return [join(REPO_ROOT, relative.startsWith('data/') ? `public/${relative}` : relative)]
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&ndash;/gi, '-')
    .replace(/&mdash;/gi, '-')
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

function normalizeText(value) {
  return decodeEntities(value)
    .replace(/\uFEFF/g, '')
    .replace(/\f/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function linesFromText(value) {
  return normalizeText(value)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function extractBetween(value, startRegex, endRegex) {
  const start = value.search(startRegex)
  if (start < 0) return null
  const afterStart = value.slice(start)
  const end = afterStart.search(endRegex)
  return end >= 0 ? afterStart.slice(0, end) : afterStart
}

function extractHtmlContent(html) {
  const candidates = [
    { template: 'modern-main-content', html: extractBetween(html, /<div[^>]+id=["']main-content["'][^>]*>/i, /<div[^>]+id=["']shareIcons["'][^>]*>|<div[^>]+id=["']footer["'][^>]*>/i) },
    { template: 'legacy-instance-editable', html: extractBetween(html, /<!--\s*InstanceBeginEditable\s+name=["']content["']\s*-->/i, /<!--\s*InstanceEndEditable\s*-->/i) },
    { template: 'legacy-main-column', html: extractBetween(html, /<div[^>]+id=["']mainColumn["'][^>]*>/i, /<!--\s*InstanceEndEditable\s*-->|<div[^>]+id=["']footer["'][^>]*>/i) },
  ]
  return candidates.find((candidate) => candidate.html && /Flood|Streamflow|River Forecast/i.test(candidate.html)) ?? { template: 'unknown-html', html }
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

  return linesFromText(withBlocks)
    .filter((line) => !/^Flood Warnings and Advisories$/i.test(line))
    .filter((line) => !/^Back to page of Flood Warnings and Advisories$/i.test(line))
}

function splitBodyFooter(lines) {
  const footerStart = lines.findIndex((line) =>
    /^(?:Contact(?: for Media Relations)?|Levels of Warnings\/Advisories|Links):/i.test(line) ||
    /^A High Streamflow Advisory means/i.test(line) ||
    /^A Flood Watch means/i.test(line)
  )
  return {
    bodyLines: footerStart >= 0 ? lines.slice(0, footerStart) : lines,
    footerLines: footerStart >= 0 ? lines.slice(footerStart) : [],
  }
}

function joinWrappedBullets(lines) {
  const out = []
  for (const line of lines) {
    const previous = out[out.length - 1]
    if (previous && /^[-•*]\s+/.test(previous) && !/^[-•*]\s+/.test(line) && !looksLikeLeadLine(line) && !looksLikeBodyStart(line) && line.length < 180) {
      out[out.length - 1] = `${previous} ${line}`
    } else {
      out.push(line)
    }
  }
  return out
}

function isHtmlAdvisory(advisory) {
  return /html?/i.test(advisory.contentType ?? '') || /\.html?$/i.test(advisory.rawPath ?? '')
}

async function normalizedSource(advisory) {
  if (isHtmlAdvisory(advisory)) {
    const rawPath = await firstExistingPath(publicPathCandidates(advisory.rawPath, 'raw'))
    const html = await readFile(rawPath, 'utf8')
    const selected = extractHtmlContent(html)
    const allLines = htmlToLines(selected.html)
    const { bodyLines, footerLines } = splitBodyFooter(allLines)
    return {
      sourceKind: 'cleaned_html',
      template: selected.template,
      rawPath,
      textPath: null,
      lines: joinWrappedBullets(bodyLines),
      footerLines,
      bodyLineCount: bodyLines.length,
      footerLineCount: footerLines.length,
    }
  }

  const existingTextPath = await existingPath(publicPathCandidates(advisory.textPath, 'text'))
  const text = existingTextPath ? await readFile(existingTextPath, 'utf8') : await extractPdfTextFromRaw(advisory)
  const lines = joinWrappedBullets(linesFromText(text))
  return {
    sourceKind: 'pdf_text',
    template: null,
    rawPath: null,
    textPath: existingTextPath,
    lines,
    footerLines: [],
    bodyLineCount: lines.length,
    footerLineCount: null,
  }
}

async function extractPdfTextFromRaw(advisory) {
  const rawPath = await existingPath(publicPathCandidates(advisory.rawPath, 'raw'))
  if (!rawPath) throw new Error(`Missing raw PDF for ${advisory.id}`)
  const { stdout } = await execFileAsync('pdftotext', ['-q', '-layout', '-enc', 'UTF-8', rawPath, '-'], {
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout
}

function looksLikeLeadLine(line) {
  return new RegExp(`\\b(?:River Forecast Centre is|River Forecast Centre are).*\\b${LEVEL}\\b`, 'i').test(line)
}

function looksLikeBodyStart(line) {
  return /^(?:Weather Synopsis|River Conditions|Current Conditions|Forecast|Outlook|Contact|Levels of Warnings\/Advisories|Links):/i.test(line) ||
    /^(?:A ridge|A series|Rain|Rainfall|Rivers?|River levels|Flows?\s+(?:in|on)|Current hydrologic|The public|A summary of river conditions|Environment and Climate Change Canada|Temperatures?|Given the current|Water levels)\b/i.test(line)
}

function normalizeStatus(value) {
  if (!value) return null
  const key = value.toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').at(-1)
  return STATUS_FROM_ACTION[key] ?? null
}

function statusFromLine(line, fallback = null) {
  const paren = line.match(/\((NEW|ISSUED|UPDATE|UPDATED|UPGRADED|DOWNGRADED|MAINTAINED|ENDED|CANCELLED|CANCELED|UPGRADE|DOWNGRADE|MAINTAIN)\)/i)?.[1]
  if (paren) return normalizeStatus(paren)
  const direct = line.match(/\b(issuing|issued|maintaining|maintained|updating|updated|upgrading|upgraded|downgrading|downgraded|ending|ended|cancelled|canceled)\b/i)?.[1]
  return normalizeStatus(direct) ?? fallback
}

function filenameAction(advisory) {
  const stem = basename(advisory.rawPath || advisory.textPath || advisory.id || '').replace(/\.[^.]+$/, '')
  const token = stem.match(/(?:_|-)(iss|issu|upd|update|upg|upgr|dwn|dng|dgd|mai|main|end)(?:_|-|$)/i)?.[1]?.toLowerCase()
  return token ? FILENAME_ACTIONS[token] ?? null : null
}

function cleanArea(value) {
  return value
    .replace(/^[-•*]\s*/, '')
    .replace(new RegExp(`^${LEVEL}\\s*(?:\\([^)]*\\))?\\s*[-:]\\s*`, 'i'), '')
    .replace(/\s+\((?:NEW|ISSUED|UPDATE|UPDATED|UPGRADED|DOWNGRADED|MAINTAINED|ENDED|UPGRADE|DOWNGRADE|MAINTAIN)\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractRivers(text) {
  const matches = []
  for (const segment of text.split(/[.;:\n]|The River Forecast Centre|The BC River Forecast Centre/i)) {
    matches.push(...(segment.match(/\b[A-Z][A-Za-z'’.-]*(?:\s+[A-Z][A-Za-z'’.-]*){0,5}\s+(?:River|Creek|tributaries|Tributaries)\b/g) ?? []))
  }
  return Array.from(new Set(matches
    .map((value) => value.replace(/\s+The\s+.*$/i, '').trim())
    .filter((value) => !/^The River$/i.test(value))
    .filter((value) => !/\bForecast Centre\b/i.test(value))
  ))
}

function pushBlock(blocks, block) {
  if (!block) return
  const areas = Array.from(new Set(block.areas.map(cleanArea).filter(Boolean)))
  blocks.push({
    level: normalizeLevel(block.level),
    status: block.status,
    isActive: block.status ? !['ended', 'cancelled'].includes(block.status) : null,
    headingLine: block.headingLine,
    areas,
    rivers: extractRivers([block.headingLine, ...areas, ...block.evidenceLines].join('\n')),
    evidenceLines: Array.from(new Set(block.evidenceLines.filter(Boolean))),
  })
}

function normalizeLevel(value) {
  const match = value?.match(/\b(Flood Warning|Flood Watch|High Streamflow Advisory)\b/i)?.[1]
  if (!match) return null
  return match.toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase())
}

function advisoryBlocksFromLines(lines, title, fallbackStatus) {
  const blocks = []
  let current = null
  const leadRegex = new RegExp(`^(?:The\\s+(?:BC\\s+)?River Forecast Centre\\s+)?(?:is|are)\\s+(?<action>issuing|maintaining|updating|upgrading|downgrading|ending|issuing or maintaining|maintaining or upgrading)(?:\\s+(?:the|a|to|or))*\\s+(?<level>${LEVEL})\\s*(?:for(?: the)?|including)?:?\\s*(?<inlineArea>.*)$`, 'i')
  const directRegex = new RegExp(`^(?:(?<prefixStatus>UPDATE|UPDATED|UPGRADED|DOWNGRADED|MAINTAINED|ENDED|ISSUED|NEW)\\s*[-:]\\s*)?(?<level>${LEVEL})\\s*(?:\\((?<preStatus>[^)]*)\\))?\\s*[-:]\\s*(?<area>.+?)(?:\\s+\\((?<status>NEW|ISSUED|UPDATE|UPDATED|UPGRADED|DOWNGRADED|MAINTAINED|ENDED|UPGRADE|DOWNGRADE|MAINTAIN)\\))?$`, 'i')

  const candidateLines = [...(title ? [title] : []), ...lines]
  for (const line of candidateLines) {
    const lead = line.match(leadRegex)
    if (lead) {
      pushBlock(blocks, current)
      const status = normalizeStatus(lead.groups.action) ?? fallbackStatus
      current = {
        level: lead.groups.level,
        status,
        headingLine: line,
        areas: lead.groups.inlineArea ? [lead.groups.inlineArea] : [],
        evidenceLines: [line],
      }
      continue
    }

    const direct = line.match(directRegex)
    if (direct && !/\bmeans that\b/i.test(line)) {
      const status = normalizeStatus(direct.groups.prefixStatus) ?? statusFromLine(line, fallbackStatus)
      const block = {
        level: direct.groups.level,
        status,
        headingLine: line,
        areas: [direct.groups.area],
        evidenceLines: [line],
      }
      if (current && /^[-•*]\s+/.test(line)) current.areas.push(line)
      else pushBlock(blocks, block)
      continue
    }

    if (current) {
      if (looksLikeBodyStart(line) || looksLikeLeadLine(line)) {
        pushBlock(blocks, current)
        current = null
      } else if (/^[-•*]\s+/.test(line)) {
        current.areas.push(line)
        current.evidenceLines.push(line)
      }
    }
  }
  pushBlock(blocks, current)

  return dedupeBlocks(blocks).slice(0, 30)
}

function dedupeBlocks(blocks) {
  const seen = new Set()
  return blocks.filter((block) => {
    const key = [block.level, block.status, block.areas.join('|') || block.headingLine].join('::').toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function extractIssuedText(lines) {
  const actionRegex = /\b(?:ISSUED|UPDATED|ENDED|UPGRADED|DOWNGRADED|MAINTAINED|Issued|Updated|Ended|Upgraded|Downgraded|Maintained)\b\s*[:\-\u2013]?\s*/i
  const payloadRegexes = [
    /\d{1,2}:\d{2}\s*(?:AM|PM)?\s+[A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}/i,
    /\d{3,4}\s*(?:h|AM|PM)?\s+[A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}/i,
    /[A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?/i,
    /\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?/i,
    /\d{1,2}[A-Za-z]+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?/i,
  ]
  const topLines = lines.slice(0, 14)
  for (let index = 0; index < topLines.length; index += 1) {
    const line = topLines[index]
    const action = line.match(actionRegex)?.[0]
    const searchLines = [line, `${line} ${topLines[index + 1] ?? ''}`]
    for (const searchLine of searchLines) {
      for (const regex of payloadRegexes) {
        const payload = searchLine.match(regex)?.[0]
        if (payload) return `${action ?? ''}${payload}`.replace(/\s+/g, ' ').trim()
      }
    }
  }
  return null
}

function parseIssuedLocal(issuedText) {
  if (!issuedText) return { iso: null, flags: [] }
  const flags = []
  const monthNames = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
    july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
  }
  const patterns = [
    /(?<time>\d{1,2}:\d{2}\s*(?:AM|PM)?)\s+(?<month>[A-Za-z]+)\s+(?<day>\d{1,2})(?:st|nd|rd|th)?,?\s+(?<year>\d{4})/i,
    /(?<time>\d{3,4})\s*(?:h|(?<compactMeridiem>AM|PM))?\s+(?<month>[A-Za-z]+)\s+(?<day>\d{1,2})(?:st|nd|rd|th)?,?\s+(?<year>\d{4})/i,
    /(?<month>[A-Za-z]+)\s+(?<day>\d{1,2})(?:st|nd|rd|th)?,?\s+(?<year>\d{4})\s+(?<time>\d{1,2}:\d{2}\s*(?:AM|PM)?|\d{3,4}\s*(?:AM|PM)?)/i,
    /(?<day>\d{1,2})\s+(?<month>[A-Za-z]+)\s+(?<year>\d{4})\s+(?<time>\d{1,2}:\d{2}\s*(?:AM|PM)?|\d{3,4}\s*(?:AM|PM)?)/i,
    /(?<day>\d{1,2})(?<month>[A-Za-z]+)(?<year>\d{4})\s+(?<time>\d{1,2}:\d{2}\s*(?:AM|PM)?)/i,
  ]
  const match = patterns.map((regex) => issuedText.match(regex)).find(Boolean)
  if (!match?.groups) return { iso: null, flags: ['issued_text_unparsed'] }
  const month = monthNames[match.groups.month.toLowerCase()]
  if (!month) return { iso: null, flags: ['issued_text_unparsed'] }
  const { hour, minute, flags: timeFlags } = parseTime(match.groups.time, match.groups.compactMeridiem)
  flags.push(...timeFlags)
  const iso = `${match.groups.year}-${String(month).padStart(2, '0')}-${String(Number.parseInt(match.groups.day, 10)).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-08:00`
  return { iso, flags }
}

function parseTime(rawTime, compactMeridiem = null) {
  const flags = []
  const normalized = rawTime.replace(/\s+/g, '').toUpperCase()
  const meridiem = normalized.match(/(AM|PM)$/)?.[1] ?? compactMeridiem ?? null
  const digits = normalized.replace(/(AM|PM|H)$/i, '')
  let hour
  let minute
  if (digits.includes(':')) {
    const [h, m] = digits.split(':')
    hour = Number.parseInt(h, 10)
    minute = Number.parseInt(m, 10)
  } else {
    const padded = digits.padStart(4, '0')
    hour = Number.parseInt(padded.slice(0, -2), 10)
    minute = Number.parseInt(padded.slice(-2), 10)
  }
  const originalHour = hour
  if (meridiem === 'PM' && hour < 12) hour += 12
  if (meridiem === 'AM' && hour === 12) hour = 0
  if (meridiem && originalHour > 12 && digits.includes(':')) flags.push('invalid_meridiem_ignored')
  if (!meridiem && hour >= 1 && hour <= 12) flags.push('ambiguous_meridiem')
  return { hour, minute, flags }
}

function cleanTitle(title, issuedText) {
  if (!title) return null
  const withoutIssued = issuedText ? title.replace(issuedText, '') : title
  return withoutIssued.replace(/\s+\b(?:ISSUED|UPDATED|Issued|Updated)\s*[:\-\u2013]?\s*$/i, '').replace(/\s+/g, ' ').trim()
}

function inferTitle(advisory, lines) {
  const top = []
  for (const line of lines.slice(0, 10)) {
    if (/^The (BC )?River Forecast Centre is\b/i.test(line) || /^The following Flood Warnings/i.test(line)) break
    if (new RegExp(`\\b${LEVEL}\\b`, 'i').test(line) || /^(ISSUED|UPDATED|ENDED|MAINTAINED|DOWNGRADED|UPGRADED)[:\\s-]/i.test(line)) top.push(line)
  }
  return top.join(' ').replace(/\s+/g, ' ').trim() || advisory.title || null
}

function sentenceMatches(lines, regex, max = 12) {
  const chunks = lines.join('\n').split(/(?<=[.!?])\s+|\n+/).map((chunk) => chunk.trim()).filter(Boolean)
  return chunks.filter((chunk) => regex.test(chunk) && !/^Links:/i.test(chunk) && !/^Levels of Warnings\/Advisories:/i.test(chunk)).slice(0, max)
}

function issuerMinistry(lines) {
  const line = lines.find((candidate) => /^Ministry of\b/i.test(candidate)) ?? lines.find((candidate) => /\bMinistry of\b/i.test(candidate))
  return line?.match(/\bMinistry of\s+.+?(?=\s+Tel:|$)/i)?.[0]?.replace(/:$/, '').trim() ?? null
}

function sectionsFromLines(lines) {
  const headingRegex = /^(Weather Synopsis|River Conditions|Current Conditions|Forecast|Outlook|Contact|Links|Definitions):?$/i
  const sections = []
  let current = null
  lines.forEach((line, index) => {
    const heading = line.match(headingRegex)?.[1]
    if (heading) {
      if (current) {
        current.endLine = index - 1
        sections.push(current)
      }
      current = { heading, normalizedHeading: normalizeHeading(heading), textLines: [], startLine: index, endLine: index }
    } else if (current) {
      current.textLines.push(line)
      current.endLine = index
    }
  })
  if (current) sections.push(current)
  return sections.map((section) => ({
    heading: section.heading,
    normalizedHeading: section.normalizedHeading,
    text: section.textLines.join('\n'),
    startLine: section.startLine,
    endLine: section.endLine,
  }))
}

function normalizeHeading(heading) {
  const key = heading.toLowerCase()
  if (key.includes('weather')) return 'weather_synopsis'
  if (key.includes('river')) return 'river_conditions'
  if (key.includes('current')) return 'current_conditions'
  if (key.includes('forecast')) return 'forecast'
  if (key.includes('outlook')) return 'outlook'
  if (key.includes('contact')) return 'contact'
  if (key.includes('links')) return 'links'
  if (key.includes('definitions')) return 'definitions'
  return 'other'
}

function hydrometricObservations(lines) {
  const relevant = sentenceMatches(lines, /\b(?:\d{2}[A-Z]{2}\d{3}|m3\/s|m³\/s|cms|gauge|water level|return period|flowing at|running at|peaked at)\b/i, 30)
  return relevant.map((evidence) => {
    const stationId = evidence.match(/\b\d{2}[A-Z]{2}\d{3}\b/)?.[0] ?? null
    const flowMatch = evidence.match(/\b(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:m3\/s|m³\/s|cms)\b/i)
    const gaugeMatch = evidence.match(/\b(?:gauge height|gauge water level|water level(?: is| of)?|level is)\s*(?:of|at|is)?\s*(\d+(?:\.\d+)?)\s*m\b/i)
    const returnPeriod = evidence.match(/\b(?:below|above|between|over|around|about|near|approaching)?\s*(?:the\s*)?\d+\s*(?:-|to|and)?\s*\d*\s*[- ]?year return period\b/i)?.[0] ?? evidence.match(/\b\d+\s*[- ]?year flow\b/i)?.[0] ?? null
    const trend = evidence.match(/\b(rising|falling|receding|peaking|peaked|stable|steady|dropping|increasing)\b/i)?.[1]?.toLowerCase() ?? null
    return {
      stationId,
      stationName: stationId ? evidence.slice(0, evidence.indexOf(stationId)).replace(/[,(]\s*$/, '').trim() || null : null,
      flow: flowMatch ? { value: Number.parseFloat(flowMatch[1].replace(/,/g, '')), unit: /cms/i.test(flowMatch[0]) ? 'cms' : 'm3/s' } : null,
      gaugeHeightM: gaugeMatch ? Number.parseFloat(gaugeMatch[1]) : null,
      returnPeriod,
      trend: normalizeTrend(trend),
      observedAtText: null,
      evidence,
    }
  })
}

function normalizeTrend(value) {
  if (!value) return null
  if (['rising', 'increasing'].includes(value)) return 'rising'
  if (['falling', 'dropping'].includes(value)) return 'falling'
  if (value === 'receding') return 'receding'
  if (['peaking', 'peaked'].includes(value)) return 'peaking'
  if (['stable', 'steady'].includes(value)) return 'stable'
  return null
}

function observedOrForecast(evidence) {
  if (/\b(?:forecast|expected|may|could|potential|by|through|into|anticipated|will likely)\b/i.test(evidence)) return 'forecast'
  if (/\b(?:observed|recorded|has been|currently|is flowing|running at|current)\b/i.test(evidence)) return 'current'
  return 'unknown'
}

function comparatorFromText(value) {
  const match = value.match(/\b(up to|over|above|below|around|approximately|about|near|exceed(?:ing)?)\b/i)?.[1]?.toLowerCase()
  if (!match) return null
  return {
    'up to': 'up_to',
    over: 'over',
    above: 'above',
    below: 'below',
    around: 'around',
    approximately: 'approximately',
    about: 'around',
    near: 'near',
    exceed: 'exceed',
    exceeding: 'exceed',
  }[match] ?? null
}

function weatherAndForecast(lines) {
  const precipitationMentions = sentenceMatches(lines, /\b(?:precipitation|rainfall|heavy rain|rain-on-snow|mm\b|millimetres?|atmospheric river)\b/i)
  const temperatureMentions = sentenceMatches(lines, /\b(?:temperatures?|warming|cooling|degrees?|°C|heat|hot)\b/i)
  return {
    precipitationMentions,
    snowmeltMentions: sentenceMatches(lines, /\b(?:snowmelt|snow melt|snowpack|snow pack|freshet|freezing levels?)\b/i),
    temperatureMentions,
    forecastMentions: sentenceMatches(lines, /\b(?:forecast|expected|anticipated|through|into|by later|tonight|tomorrow|weekend|next week)\b/i),
    modelMentions: sentenceMatches(lines, /\b(?:CLEVER|COFFEE|hydrologic(?:al)? model|modelling|modeling)\b/i),
    precipitationAmounts: extractAmounts(precipitationMentions, 'mm'),
    temperatureValues: extractAmounts(temperatureMentions, 'degC'),
  }
}

function weatherQuantities(lines) {
  const evidenceLines = sentenceMatches(lines, /\b(?:rainfall|precipitation|rain|downpours?|snowmelt|snow melt|freezing levels?|temperatures?|mm\b|°C|degrees?)\b/i, 80)
  const quantities = []
  for (const evidence of evidenceLines) {
    const station = evidence.match(/\bat\s+([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,4})\s+\((\d[A-Z]\d{2}P)\)/)
    const periodText = evidence.match(/\b(?:past\s+\d+\s*-?\s*hours?|through\s+[^,.]+|from\s+[^,.]+|by\s+[^,.]+|overnight|tonight|tomorrow|weekend)\b/i)?.[0] ?? null
    const locationText = evidence.match(/\b(?:over|in|near|on)\s+([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,5}(?:basin|watershed|region|area|Island|Coast|Mountains|Lake)?)\b/)?.[1] ?? null

    for (const match of evidence.matchAll(/\b(?:(?<cmp>up to|over|above|below|around|approximately|about|near|exceeding?)\s+)?(?:(?<min>\d+(?:\.\d+)?)\s*(?:-|to|and)\s*(?:over\s+)?(?<max>\d+(?:\.\d+)?)|(?<value>\d+(?:\.\d+)?))\s*(?<unit>mm)(?:\s*(?:\/|per)\s*(?<rate>hour|day))?\b/gi)) {
      quantities.push({
        kind: /\bsnowmelt|snow melt|melt rates?\b/i.test(evidence) ? 'snowmelt' : /\brainfall|rain\b/i.test(evidence) ? 'rainfall' : 'precipitation',
        value: match.groups.value ? Number.parseFloat(match.groups.value) : undefined,
        min: match.groups.min ? Number.parseFloat(match.groups.min) : undefined,
        max: match.groups.max ? Number.parseFloat(match.groups.max) : undefined,
        comparator: match.groups.cmp ? comparatorFromText(match.groups.cmp) : null,
        unit: match.groups.rate ? `mm/${match.groups.rate}` : 'mm',
        periodText,
        timingText: periodText,
        locationText,
        stationName: station?.[1] ?? null,
        stationId: station?.[2] ?? null,
        observedOrForecast: observedOrForecast(evidence),
        evidence,
      })
    }

    for (const match of evidence.matchAll(/\bfreezing levels?.{0,80}?(?:(?<cmp>above|below|around|near|up to)\s+)?(?:(?<min>\d+(?:\.\d+)?)\s*(?:-|to|and)\s*(?<max>\d+(?:\.\d+)?)|(?<value>\d+(?:\.\d+)?))\s*m\b/gi)) {
      quantities.push({
        kind: 'freezing_level',
        value: match.groups.value ? Number.parseFloat(match.groups.value) : undefined,
        min: match.groups.min ? Number.parseFloat(match.groups.min) : undefined,
        max: match.groups.max ? Number.parseFloat(match.groups.max) : undefined,
        comparator: match.groups.cmp ? comparatorFromText(match.groups.cmp) : null,
        unit: 'm',
        periodText,
        timingText: periodText,
        locationText,
        observedOrForecast: observedOrForecast(evidence),
        evidence,
      })
    }

    for (const match of evidence.matchAll(/\b(?:(?<min>-?\d+(?:\.\d+)?)\s*(?:-|to)\s*(?<max>-?\d+(?:\.\d+)?)|(?<value>-?\d+(?:\.\d+)?))\s*(?:°C|degrees?(?: Celsius)?)\b/gi)) {
      quantities.push({
        kind: 'temperature',
        value: match.groups.value ? Number.parseFloat(match.groups.value) : undefined,
        min: match.groups.min ? Number.parseFloat(match.groups.min) : undefined,
        max: match.groups.max ? Number.parseFloat(match.groups.max) : undefined,
        comparator: comparatorFromText(evidence),
        unit: 'degC',
        periodText,
        timingText: periodText,
        locationText,
        observedOrForecast: observedOrForecast(evidence),
        evidence,
      })
    }
  }
  return quantities
}

function hydrometricObservationsV2(lines) {
  const relevant = sentenceMatches(lines, /\b(?:\d{2}[A-Z]{2}\d{3}|m3\/s|m³\/s|cms|gauge|water level|return period|flowing at|running at|peaked at|forecast to reach|expected to reach|cm\b|ft\b)\b/i, 80)
  const observations = []
  for (const evidence of relevant) {
    const stationMatch = evidence.match(/\b([^.;\n]{0,120}?)\s*\((?:WSC|Water Survey of Canada(?: Gauge)?|Gauge)?\s*(\d{2}[A-Z]{2}\d{3})\)/i)
    const stationName = stationMatch?.[1]?.replace(/^[-•*]\s*/, '').replace(/\b(?:at|near|on)\s*$/i, '').trim() || null
    const stationId = stationMatch?.[2] ?? evidence.match(/\b\d{2}[A-Z]{2}\d{3}\b/)?.[0] ?? null
    const returnPeriod = parseReturnPeriod(evidence)
    const timingText = evidence.match(/\b(?:today|tonight|tomorrow|overnight|this afternoon|this evening|by\s+[^,.]+|through\s+[^,.]+|into\s+[^,.]+|weekend|next week)\b/i)?.[0] ?? null
    const trend = normalizeTrend(evidence.match(/\b(rising|falling|receding|peaking|peaked|stable|steady|dropping|increasing|easing)\b/i)?.[1]?.toLowerCase() ?? null)

    for (const match of evidence.matchAll(/\b(?:(?<cmp>approximately|about|near|above|below|up to)\s+)?(?:(?<min>\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:-|to|and)\s*(?<max>\d+(?:,\d{3})*(?:\.\d+)?)|(?<value>\d+(?:,\d{3})*(?:\.\d+)?))\s*(?<unit>m3\/s|m³\/s|cms)\b/gi)) {
      observations.push({
        stationName,
        stationId,
        waterbody: stationName,
        measurementType: 'flow',
        value: match.groups.value ? Number.parseFloat(match.groups.value.replace(/,/g, '')) : undefined,
        min: match.groups.min ? Number.parseFloat(match.groups.min.replace(/,/g, '')) : undefined,
        max: match.groups.max ? Number.parseFloat(match.groups.max.replace(/,/g, '')) : undefined,
        comparator: match.groups.cmp ? comparatorFromText(match.groups.cmp) : null,
        unit: /cms/i.test(match.groups.unit) ? 'cms' : 'm3/s',
        observedOrForecast: observedOrForecast(evidence),
        trend,
        timingText,
        returnPeriod,
        evidence,
      })
    }

    for (const match of evidence.matchAll(/\b(?:gauge height|gauge water level|water level(?: is)?|level(?: of)?|crest of|increase)\s*(?:is|of|at|to|by)?\s*(?:(?<min>\d+(?:\.\d+)?)\s*(?:-|to|and)\s*(?<max>\d+(?:\.\d+)?)|(?<value>\d+(?:\.\d+)?))\s*(?<unit>m|cm|ft)\b/gi)) {
      observations.push({
        stationName,
        stationId,
        waterbody: stationName,
        measurementType: /increase/i.test(match[0]) ? 'level_change' : 'gauge_height',
        value: match.groups.value ? Number.parseFloat(match.groups.value) : undefined,
        min: match.groups.min ? Number.parseFloat(match.groups.min) : undefined,
        max: match.groups.max ? Number.parseFloat(match.groups.max) : undefined,
        comparator: comparatorFromText(evidence),
        unit: match.groups.unit.toLowerCase(),
        observedOrForecast: observedOrForecast(evidence),
        trend,
        timingText,
        returnPeriod,
        evidence,
      })
    }
  }
  return observations
}

function parseReturnPeriod(evidence) {
  const match = evidence.match(/\b(?<cmp>above|below|between|near|approaching|close to|slightly above|slightly lower than|over)?\s*(?:a|the)?\s*(?<min>\d+)\s*(?:-|to|and)?\s*(?<max>\d+)?\s*[- ]?year(?: return period)?(?: flow| event| level| range)?s?\b/i)
  if (!match) return null
  return {
    minYears: Number.parseInt(match.groups.min, 10),
    maxYears: match.groups.max ? Number.parseInt(match.groups.max, 10) : undefined,
    comparator: comparatorFromText(match.groups.cmp ?? '') ?? (match.groups.max ? 'between' : null),
    text: match[0],
  }
}

function forecastEvents(lines) {
  return forecastTiming(lines).map((event) => ({
    subject: event.phenomenon?.includes('rain') ? 'rainfall' :
      event.phenomenon?.includes('flow') ? 'flow' :
      event.phenomenon?.includes('level') ? 'water_level' :
      event.phenomenon?.includes('snow') ? 'snowmelt' :
      event.phenomenon?.includes('temperature') ? 'temperature' : null,
    trend: event.evidence.match(/\b(rise|rising|increase|peak|recede|receding|fall|drop|remain high|stabili[sz]e)\b/i)?.[1]?.toLowerCase() ?? null,
    timingText: event.timingText,
    locationText: event.evidence.match(/\b(?:in|on|over|near|around)\s+([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,5})\b/)?.[1] ?? null,
    evidence: event.evidence,
  }))
}

function extractAmounts(evidenceLines, kind) {
  const amountRegex = kind === 'mm'
    ? /\b(?<min>\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(?<max>\d+(?:\.\d+)?)\s*(?<unit>mm|millimetres?)\b|\b(?:up to|over|around|about|additional|total of)?\s*(?<value>\d+(?:\.\d+)?)\s*(?<singleUnit>mm|millimetres?)\b/gi
    : /\b(?<min>-?\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(?<max>-?\d+(?:\.\d+)?)\s*(?<unit>°C|degrees?(?: Celsius)?)\b|\b(?<value>-?\d+(?:\.\d+)?)\s*(?<singleUnit>°C|degrees?(?: Celsius)?)\b/gi
  const amounts = []
  for (const evidence of evidenceLines) {
    for (const match of evidence.matchAll(amountRegex)) {
      amounts.push({
        min: match.groups.min ? Number.parseFloat(match.groups.min) : Number.parseFloat(match.groups.value),
        max: match.groups.max ? Number.parseFloat(match.groups.max) : null,
        unit: kind,
        qualifier: evidence.slice(Math.max(0, match.index - 24), match.index).match(/\b(up to|over|around|about|additional|total(?: of)?|expected|forecast)\b/gi)?.at(-1)?.toLowerCase() ?? null,
        evidence,
      })
    }
  }
  return amounts
}

function forecastTiming(lines) {
  return sentenceMatches(lines, /\b(?:today|tonight|tomorrow|overnight|weekend|next week|through|into|by later|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|morning|afternoon|evening)\b/i, 20)
    .map((evidence) => ({
      timingText: evidence.match(/\b(?:today|tonight|tomorrow|overnight|weekend|next week|through\s+[^,.]+|into\s+[^,.]+|by later\s+[^,.]+|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:\s+(?:morning|afternoon|evening))?)\b/i)?.[0] ?? null,
      phenomenon: evidence.match(/\b(rainfall|rain|peak flows?|river levels?|flows?|recede|rise|snowmelt|update)\b/i)?.[1]?.toLowerCase() ?? null,
      evidence,
    }))
}

function geography(advisory, blocks) {
  const namedAreas = Array.from(new Set((advisory.namedAreas ?? [])
    .map((area) => area?.trim())
    .filter((area) => area && area.length <= 80)
    .filter((area) => !/^(?:NEW|UPDATED?|ISSUED|MAINTAINED|DOWNGRADED|UPGRADED|ENDED|\d{4}|[:\d\sAPM]+)$/i.test(area))
    .filter((area) => !/^(?:Land|Lands|FLNRO|Water|Resource Stewardship|Ministry Water)$/i.test(area))
    .filter((area) => !/^[:\s-]/.test(area))
    .filter((area) => !/\b(?:Ministry|Province|Forecast Centre|Skip to|Accessibility|Search Form|Resource Stewardship|Natural Resource Operations)\b/i.test(area))
    .filter((area) => !/\b(?:UPDATED?|ISSUED)\s*:/i.test(area))
  ))
  const matchedBoundaries = advisory.matchedBoundaries ?? []
  const rivers = Array.from(new Set([
    ...blocks.flatMap((block) => block.rivers),
    ...matchedBoundaries.filter((boundary) => /\bRiver\b/i.test(boundary.name ?? '')).map((boundary) => boundary.name),
  ].filter(Boolean)))
  const communities = Array.from(new Set(blocks.flatMap((block) => block.areas.flatMap(extractCommunitiesFromArea))))
  return {
    namedAreas,
    regions: namedAreas.filter((area) => /\b(?:Region|Interior|Coast|Island|Fraser|Kootenay|Columbia|Peace|Skeena|Thompson|Okanagan|Cariboo|Haida Gwaii)\b/i.test(area)),
    rivers,
    communities,
    matchedBoundaries,
    boundarySources: Array.from(new Set(matchedBoundaries.map((boundary) => boundary.source).filter(Boolean))),
  }
}

function attachBlockGeography(blocks, documentGeography) {
  return blocks.map((block, index) => {
    const evidence = [block.headingLine, ...block.areas, ...block.rivers].join(' ').toLowerCase()
    const matchedBoundaries = documentGeography.matchedBoundaries
      .map((boundary) => {
        const name = boundary.name ?? ''
        if (!name) return null
        const normalizedName = name.toLowerCase()
        const exact = evidence.includes(normalizedName)
        const riverStem = normalizedName.replace(/\s+river$/, '')
        const stemMatch = riverStem.length > 4 && evidence.includes(riverStem)
        if (!exact && !stemMatch) return null
        return {
          ...boundary,
          matchConfidence: exact ? 'high' : 'medium',
          matchMethod: exact ? 'exact_name' : 'normalized_name',
          evidenceText: block.evidenceLines[0] ?? block.headingLine,
          inheritedFromDocument: true,
        }
      })
      .filter(Boolean)

    return {
      id: `${index + 1}`,
      ...block,
      communities: Array.from(new Set(block.areas.flatMap(extractCommunitiesFromArea))),
      matchedBoundaries,
      boundaryInheritance: {
        mode: matchedBoundaries.length > 0 ? 'filtered_document_match' : 'none',
        confidence: matchedBoundaries.some((boundary) => boundary.matchConfidence === 'high') ? 'high' : matchedBoundaries.length > 0 ? 'medium' : 'low',
      },
    }
  })
}

function extractCommunitiesFromArea(area) {
  const matches = area.match(/\b(?:around|near|including areas around|from|to)\s+([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,3})/g) ?? []
  return matches
    .map((match) => match.replace(/^(?:around|near|including areas around|from|to)\s+/i, '').trim())
    .filter((value) => !/\b(?:River|Creek|tributaries|areas|region)\b/i.test(value))
}

function archiveMetadata(advisory) {
  const downloadedFrom = advisory.downloadedFrom ?? null
  const waybackTimestamp = downloadedFrom?.match(/web\.archive\.org\/web\/(\d{14})/i)?.[1] ?? null
  return {
    downloadedFrom,
    waybackTimestamp,
    duplicateUrls: advisory.duplicateUrls ?? [],
    sourceMethods: advisory.sourceMethods ?? [],
    byteLength: advisory.byteLength ?? null,
    textLength: advisory.textLength ?? null,
  }
}

function lifecycle(advisory, blocks) {
  const statuses = Array.from(new Set([...(advisory.statuses ?? []), ...blocks.map((block) => block.status)].filter(Boolean)))
  const activeBlockCount = blocks.filter((block) => block.isActive === true).length
  const inactiveBlockCount = blocks.filter((block) => block.isActive === false).length
  return {
    levels: advisory.levels ?? [],
    statuses,
    actionPrimary: statuses[0] ?? null,
    lifecycleSummary: inactiveBlockCount > 0 && activeBlockCount > 0 ? 'mixed' : inactiveBlockCount > 0 && activeBlockCount === 0 ? 'ended' : activeBlockCount > 0 ? 'active' : 'unknown',
    activeBlockCount,
    inactiveBlockCount,
    hasEndedBlocks: blocks.some((block) => block.status === 'ended'),
    hasMixedLevels: (advisory.levels?.length ?? 0) > 1,
  }
}

function qualityFlags(advisory, source, record) {
  const flags = []
  if (!record.document.issuedAt) flags.push('missing_issued_at')
  if (record.document.issuedText && !record.document.issuedAt) flags.push('issued_text_unparsed')
  flags.push(...(record.document.issuedParseFlags ?? []))
  if (source.sourceKind === 'cleaned_html') flags.push('html_source_cleaned_from_raw')
  if (source.template?.includes('legacy')) flags.push('legacy_html_template')
  if (record.advisoryBlocks.length === 0) flags.push('no_advisory_blocks')
  if ((advisory.levels?.length ?? 0) > 1 || /\bFlood Warning\b.*\bFlood Watch\b|\bFlood Watch\b.*\bHigh Streamflow Advisory\b/i.test(record.document.titleClean ?? '')) flags.push('multiple_levels_in_title')
  if (record.advisoryBlocks.some((block) => block.status === 'ended')) flags.push('ended_advisory')
  if (record.hydrometricObservations.some((obs) => obs.stationId && !obs.flow && !obs.gaugeHeightM)) flags.push('station_without_measurement')
  if (record.hydrometricObservations.some((obs) => !obs.stationId && (obs.flow || obs.gaugeHeightM))) flags.push('measurement_without_station')
  if (record.geography.matchedBoundaries.length === 0) flags.push('no_matched_boundaries')
  if (record.weatherAndForecast.precipitationAmounts.length > 0) flags.push('structured_precipitation_amounts')
  if (record.weatherQuantities.length > 0) flags.push('weather_quantities')
  if (record.hydrometricObservationsV2.length > 0) flags.push('hydrometric_observations_v2')
  return flags
}

function confidence(record) {
  if (record.quality.flags.includes('no_advisory_blocks')) return 'low'
  if (record.parser.sourceKind === 'cleaned_html' || record.quality.flags.includes('multiple_levels_in_title')) return 'medium'
  return 'high'
}

async function buildRecord(advisory) {
  const source = await normalizedSource(advisory)
  const lines = source.lines
  const issuedText = extractIssuedText(lines)
  const parsedIssued = parseIssuedLocal(issuedText)
  const title = inferTitle(advisory, lines)
  const titleClean = cleanTitle(title, issuedText)
  const fallbackStatus = filenameAction(advisory) ?? (advisory.statuses?.length === 1 ? advisory.statuses[0] : null)
  const blocks = advisoryBlocksFromLines(lines, titleClean, fallbackStatus)
  const documentGeography = geography(advisory, blocks)
  const enrichedBlocks = attachBlockGeography(blocks, documentGeography)

  const record = {
    schemaVersion: 'flood-advisory-structured-v1',
    source: {
      id: advisory.id,
      url: advisory.url ?? null,
      rawPath: advisory.rawPath ?? null,
      textPath: advisory.textPath ?? null,
      contentType: advisory.contentType ?? null,
      sourceSystem: 'bc-river-forecast-centre',
      issuerMinistry: issuerMinistry(lines) ?? null,
      archive: archiveMetadata(advisory),
    },
    document: {
      title,
      titleClean,
      issuedAt: advisory.issuedAt ?? parsedIssued.iso,
      issuedAtOriginal: advisory.issuedAt ?? null,
      issuedText,
      issuedParseFlags: parsedIssued.flags,
      actionFromFilename: filenameAction(advisory),
      lifecycle: lifecycle(advisory, enrichedBlocks),
    },
    parser: {
      sourceKind: source.sourceKind,
      template: source.template,
      lineCount: lines.length,
      bodyLineCount: source.bodyLineCount,
      footerLineCount: source.footerLineCount,
    },
    advisoryBlocks: enrichedBlocks,
    geography: documentGeography,
    hydrometricObservations: hydrometricObservations(lines),
    hydrometricObservationsV2: hydrometricObservationsV2(lines),
    weatherAndForecast: weatherAndForecast(lines),
    weatherQuantities: weatherQuantities(lines),
    forecastTiming: forecastTiming(lines),
    forecastEvents: forecastEvents(lines),
    sections: sectionsFromLines(lines),
    quality: {
      confidence: 'medium',
      flags: [],
      extractionNotes: [],
    },
  }
  record.quality.flags = qualityFlags(advisory, source, record)
  record.quality.confidence = confidence(record)
  if (source.sourceKind === 'cleaned_html') record.quality.extractionNotes.push('HTML record parsed from raw archive HTML because text archive is flattened.')
  if (source.footerLines.length > 0) record.quality.extractionNotes.push('Footer/contact/definitions were separated before body parsing.')
  if (process.env.PGMAPS_DEBUG_LINES === '1') record.lines = lines
  return record
}

function summarize(records, failures) {
  const byKind = {}
  const countWith = (predicate) => records.filter(predicate).length
  for (const record of records) byKind[record.parser.sourceKind] = (byKind[record.parser.sourceKind] ?? 0) + 1
  return {
    processed: records.length,
    failures: failures.length,
    bySourceKind: byKind,
    withAdvisoryBlocks: countWith((record) => record.advisoryBlocks.length > 0),
    withMatchedBoundaries: countWith((record) => record.geography.matchedBoundaries.length > 0),
    withNamedAreas: countWith((record) => record.geography.namedAreas.length > 0),
    withWaybackTimestamp: countWith((record) => record.source.archive.waybackTimestamp),
    withHydrometricObservations: countWith((record) => record.hydrometricObservations.length > 0),
    withHydrometricObservationsV2: countWith((record) => record.hydrometricObservationsV2.length > 0),
    withWeatherMentions: countWith((record) => record.weatherAndForecast.precipitationMentions.length > 0 || record.weatherAndForecast.snowmeltMentions.length > 0),
    withPrecipitationAmounts: countWith((record) => record.weatherAndForecast.precipitationAmounts.length > 0),
    withWeatherQuantities: countWith((record) => record.weatherQuantities.length > 0),
    withForecastTiming: countWith((record) => record.forecastTiming.length > 0),
    withForecastEvents: countWith((record) => record.forecastEvents.length > 0),
    confidence: records.reduce((counts, record) => {
      counts[record.quality.confidence] = (counts[record.quality.confidence] ?? 0) + 1
      return counts
    }, {}),
    commonFlags: Object.fromEntries(Object.entries(records.flatMap((record) => record.quality.flags).reduce((counts, flag) => {
      counts[flag] = (counts[flag] ?? 0) + 1
      return counts
    }, {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
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
      const record = await buildRecord(advisory)
      if (options.includeLines) record.lines = (await normalizedSource(advisory)).lines
      records.push(record)
    } catch (error) {
      failures.push({ id: advisory.id, rawPath: advisory.rawPath, textPath: advisory.textPath, error: error.message })
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
    const cwdOutPath = resolve(process.cwd(), options.out)
    const forbiddenOutputRoots = [
      join(FLOOD_DIR, 'output'),
      join(FLOOD_DIR, 'archive'),
    ]
    const normalizedOutArg = options.out.replace(/\\/g, '/')
    const targetsGeneratedFloodData = forbiddenOutputRoots.some((root) =>
      outPath === root ||
      outPath.startsWith(`${root}/`) ||
      cwdOutPath === root ||
      cwdOutPath.startsWith(`${root}/`)
    ) || /(?:^|\/)datascrapers\/bc\/flood\/(?:output|archive)(?:\/|$)/.test(normalizedOutArg)
    if (targetsGeneratedFloodData) {
      throw new Error(`Refusing to write pilot report inside generated flood data path: ${outPath}`)
    }
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, json)
    console.error(`Wrote structured advisory pilot report to ${outPath}`)
  } else {
    process.stdout.write(json)
  }
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
