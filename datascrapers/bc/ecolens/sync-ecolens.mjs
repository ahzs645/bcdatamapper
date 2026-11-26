import { execFileSync } from 'node:child_process'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'

const source = 'https://ecolens.ca/explore-map/'
const regions = new Set([
  'cariboo', 'kootenay', 'mainland-southwest', 'nechako', 'north-coast', 'northeast',
  'outside-bc', 'thompson-okanagan', 'vancouver-island-coast',
])

const html = execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--max-time', '30', source], {
  encoding: 'utf8',
})
const markers = html.match(/\bloadJsonFromPHP\(\s*(\[.*\])\s*\)\s*;?/)
if (!markers) throw new Error('The EcoLens map did not include its story marker data')
const records = JSON.parse(markers[1])
if (records.length === 0) throw new Error('The EcoLens map returned an empty marker list')

function coordinate(value) {
  return typeof value === 'string' && value.trim() ? Number(value) : value
}

const seen = new Set()
const features = records.map(({ location, lat, lng, tags, permalink }, index) => {
  const id = /^https:\/\/ecolens\.ca\/explore\/([a-z0-9-]+)\/$/.exec(permalink)?.[1]
  const latitude = coordinate(lat)
  const longitude = coordinate(lng)
  if (!id || seen.has(id) || typeof location !== 'string' || !location.trim() ||
      !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
      !Number.isFinite(longitude) || Math.abs(longitude) > 180 ||
      typeof tags !== 'string') {
    throw new Error(`Invalid or duplicate EcoLens marker at row ${index + 1}`)
  }
  seen.add(id)
  const sourceTags = [...new Set(tags.split(',').map((tag) => tag.trim()).filter(Boolean))]
  const month = sourceTags.find((tag) => /^\d{4}-(0[1-9]|1[0-2])$/.test(tag))
  const region = sourceTags.find((tag) => regions.has(tag))

  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [longitude, latitude] },
    properties: {
      title: location.trim(),
      url: permalink,
      region: region ?? 'unspecified',
      tags: sourceTags.filter((tag) => tag !== month && !regions.has(tag)),
      ...(month ? { month } : {}),
    },
  }
}).sort((a, b) => a.id.localeCompare(b.id, 'en'))

const directory = new URL('./output/', import.meta.url)
const output = new URL('story-pins.geojson', directory)
const temporaryOutput = new URL(`story-pins.geojson.${process.pid}.tmp`, directory)
const snapshot = JSON.stringify({
  type: 'FeatureCollection',
  source,
  attribution: 'EcoLens, BC Centre for Disease Control',
  coordinateNote: 'EcoLens may adjust submitted locations before publication.',
  features,
}) + '\n'

mkdirSync(directory, { recursive: true })
writeFileSync(temporaryOutput, snapshot)
renameSync(temporaryOutput, output)
console.log(`Wrote ${features.length} EcoLens story pins (${Buffer.byteLength(snapshot)} bytes)`)
