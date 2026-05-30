import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const OUTPUT_ROOT = 'public/data/healthyplan-pg'
export const PG_CITY = 'prince george'

export function splitCsvLine(line) {
  const values = []
  let current = ''
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"' && line[index + 1] === '"') {
      current += '"'
      index += 1
    } else if (char === '"') {
      quoted = !quoted
    } else if (char === ',' && !quoted) {
      values.push(current)
      current = ''
    } else {
      current += char
    }
  }

  values.push(current)
  return values
}

export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean)
  const headers = splitCsvLine(lines[0] ?? '').map((header) => header.trim())
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line)
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
  })
}

export function decodeText(buffer) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  if (!utf8.includes('\uFFFD')) return utf8
  return new TextDecoder('windows-1252').decode(buffer)
}

export async function fetchText(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'PGMaps healthyplan-pg scraper' } })
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`)
  return decodeText(await response.arrayBuffer())
}

export async function fetchJson(url, options) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'PGMaps healthyplan-pg scraper', ...(options?.headers ?? {}) },
    method: options?.method,
    body: options?.body,
  })
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`)
  return response.json()
}

export function asNumber(value) {
  if (value == null || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

export function slug(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function pointFeature({ id, source, name, category, latitude, longitude, properties }) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [longitude, latitude],
    },
    properties: {
      id,
      source,
      name,
      category,
      ...properties,
    },
  }
}

export function countBy(items, getKey) {
  const counts = {}
  for (const item of items) {
    const key = getKey(item) || 'unknown'
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

export async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(data)}\n`)
}
