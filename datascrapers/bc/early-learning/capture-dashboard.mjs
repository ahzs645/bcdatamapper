#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { ShinyClient, initialInputs, plain, charts, verifyIdentity, polygonFeatures } from './shiny.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
const release = option('--capture', new Date().toISOString().slice(0, 10))
if (!/^[a-zA-Z0-9_-]+$/.test(release)) throw new Error('Invalid capture identifier')
const limit = Number(option('--limit', Infinity))
const families = option('--families', 'GEOSD,NH,HA,HSDA,LHA,CHSA,MCFD,SDA,LSA').split(',')
const cache = join(ROOT, 'cache', 'captures', release)
mkdirSync(join(cache, 'regions'), { recursive: true }); mkdirSync(join(cache, 'boundaries'), { recursive: true })
const htmlPath = join(cache, 'source.html')
if (!existsSync(htmlPath)) writeFileSync(htmlPath, execFileSync('curl', ['-fsSL', '--max-time', '60', 'https://dashboard.earlylearning.ubc.ca/']))
const match = readFileSync(htmlPath, 'utf8').match(/const REGION_SEARCH_DATA = (\[[\s\S]*?\]);/)
if (!match) throw new Error('Missing dashboard region inventory')
const regions = JSON.parse(match[1]).map(r => ({ id: `${r.boundaryCode}_${r.regionCode}`, name: r.regionName, boundary: r.boundaryCode }))
const searchRegionCount = regions.length
const byRegion = new Map(regions.map(r => [r.id,r]))
if (byRegion.size !== regions.length) throw new Error('Duplicate region IDs in source inventory')
const waveDirectory = join(cache, 'wave-boundaries')
if (existsSync(waveDirectory)) for (const file of readdirSync(waveDirectory).filter(f => f.endsWith('.geojson'))) {
  const geometry = JSON.parse(readFileSync(join(waveDirectory,file),'utf8'))
  for (const f of geometry.features) {
    const boundary = f.properties.boundaryCode
    let region = byRegion.get(f.id)
    if (!region) {
      region = { id:f.id, name:f.properties.regionName, boundary, discoveredIn:'verified-wave-map' }
      regions.push(region); byRegion.set(region.id,region)
    }
    const wave = geometry.metadata?.displayedWave
    if (Number.isInteger(wave)) region.mappedWaves = [...new Set([...(region.mappedWaves ?? []),wave])].sort((a,b)=>a-b)
  }
}
const names = Object.fromEntries(regions.map(r => [r.id, r.name]))
writeFileSync(join(cache, 'regions.json'), JSON.stringify(regions))
const scales = ['overall', 'social', 'emotional', 'physical', 'language', 'communication']
let completed = 0, failures = []
function atomic(path, data) { writeFileSync(`${path}.tmp`, JSON.stringify(data)); renameSync(`${path}.tmp`, path) }
function saveGeometry(response, boundary) {
  const fs = response.polygons.flatMap(a => polygonFeatures(a, boundary, names))
  if (!fs.length) return
  const path = join(cache, 'boundaries', `${boundary}.geojson`)
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).features : []
  const byId = new Map([...existing, ...fs].map(f => [f.id, f]))
  atomic(path, { type: 'FeatureCollection', metadata: { source: 'https://dashboard.earlylearning.ubc.ca/', capture: release, resolution: 'Dashboard display geometry; source effective date unknown', redistributable: false }, features: [...byId.values()].sort((a,b) => a.id.localeCompare(b.id)) })
}
function extract(response, region, scale, wave = 9) {
  verifyIdentity(response.values, region.id, wave)
  const v = response.values
  if (!('scalesOutcomesChart' in response.changed) && !('scalesOutcomesChart' in response.errors)) throw new Error(`No fresh outcomes for ${region.id}/${scale}`)
  saveGeometry(response, region.boundary)
  return { scale, capturedAt: new Date().toISOString(), headline: plain(v.scalesHeadline), outcomes: charts(v.scalesOutcomesChart), vulnerability: charts(v.scalesTrendsChart), subscales: ['social','emotional','physical','language'].includes(scale) ? charts(v.subscaleTrendChartBottom) : [], meaningfulChange: plain(v.scalesCriticalDifferenceExplanation), subscaleChange: ['social','emotional','physical','language'].includes(scale) ? plain(v.subscalesCriticalDifferenceExplanation) : '', errors: response.errors }
}
async function collect(work) {
 let client
 try {
  for (const region of work) {
    const path = join(cache, 'regions', `${region.id}.json`)
    if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).collectorVersion === 2 && !args.includes('--refresh')) { completed++; continue }
    const detailWaveSelection = region.discoveredIn === 'verified-wave-map' && region.mappedWaves?.length ? 'latest_verified_map_wave' : 'latest_selectable_wave'
    let success = false, requestedWave = detailWaveSelection === 'latest_verified_map_wave' ? region.mappedWaves.at(-1) : 9, disabledWaves = []
    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      try {
        const request = initialInputs(region.id, 'overall', requestedWave)
        let response
        if (!client) { client = new ShinyClient(); response = await client.connect(request) }
        else response = await client.update(request)
        verifyIdentity(response.values,region.id,requestedWave)
        const label = [...(response.values.breadcrumb?.html ?? '').matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].at(-1)?.[1]
        const code = region.id.slice(region.boundary.length+1)
        const resolved = {...region,name:plain(label).replace(new RegExp(` - ${code}$`),'') || region.name}
        disabledWaves = [...client.disabledCases].filter(id => id.startsWith(region.id + '_')).map(id => Number(id.split('_').at(-1)))
        const result = { collectorVersion: 2, ...resolved, inventoryName:region.name, requestedWave, detailWaveSelection, disabledWaves, scales: [extract(response, resolved, 'overall', requestedWave)], demographics: plain(response.values.demoTable), participation: plain(response.values.demoParticipationTable) }
        for (const scale of scales.slice(1)) {
          const data = { scalesScaleSelector: scale, scalesTrendChartSelector: 'overall_vulnerability', '.clientdata_output_scalesMap_hidden': true }
          response = await client.update(data)
          const entry = extract(response, resolved, scale, requestedWave)
          if (['emotional','physical','language'].includes(scale)) {
            // Separate reactive updates: simultaneous scale + subscale changes can
            // leave the subscale outputs unchanged on this publisher's app.
            const sub = await client.update({ subscalesScaleSelector: scale })
            verifyIdentity(sub.values, region.id, requestedWave)
            if (!('subscaleTrendChartBottom' in sub.changed) && !('subscaleTrendChartBottom' in sub.errors)) throw new Error('No fresh subscale chart')
            entry.subscales = charts(sub.errors.subscaleTrendChartBottom ? null : sub.values.subscaleTrendChartBottom)
            entry.subscaleChange = plain(sub.values.subscalesCriticalDifferenceExplanation)
            entry.errors = { ...entry.errors, ...sub.errors }
          }
          const expected = { social: 'Overall Social Competence', emotional: 'Prosocial & Helping Behaviour', physical: 'Physical Readiness for the School Day', language: 'Basic Literacy Skills' }
          if (expected[scale] && entry.subscales.length && entry.subscales[0].name !== expected[scale]) throw new Error(`Wrong subscale returned for ${scale}: ${entry.subscales[0].name}`)
          if (entry.subscales.some(t => ![t.hover ?? []].flat().some(h => plain(h).includes(resolved.name)))) throw new Error(`Wrong area in ${scale} subscales for ${region.id}`)
          result.scales.push(entry)
        }
        response = await client.update({ scalesScaleSelector: 'overall', scalesTrendChartSelector: 'overall_multiple' })
        verifyIdentity(response.values, region.id, requestedWave)
        if (!('scalesTrendsChart' in response.changed) && !('scalesTrendsChart' in response.errors)) throw new Error('No fresh multiple-vulnerability chart')
        result.multipleVulnerabilities = charts(response.values.scalesTrendsChart)
        await client.update({ subscalesScaleSelector: 'social' })
        atomic(path, result); success = true; completed++
        console.log(`${completed}/${Math.min(regions.length,limit)} ${region.id} ${region.name}`)
        if (completed % 60 === 0) { client.close(); client = null }
      } catch (error) {
        console.error(`${region.id} attempt ${attempt + 1}: ${error.message}`)
        if (error.code === 'UNAVAILABLE_CASE') {
          disabledWaves = error.disabledCases.filter(id => id.startsWith(region.id + '_')).map(id => Number(id.split('_').at(-1)))
          const available = [2,3,4,5,6,7,8,9].filter(w => !disabledWaves.includes(w))
          requestedWave = available.at(-1) ?? 9
        }
        client?.close(); client = null
        if (attempt === 2) failures.push({ region: region.id, error: error.message })
      }
    }
  }
} finally { client?.close() }
}
const selectedRegions = option('--regions', '').split(',').filter(Boolean)
const work = regions.filter(r => families.includes(r.boundary) && (!selectedRegions.length || selectedRegions.includes(r.id))).slice(0, limit)
const workers = Math.max(1, Math.min(4, Number(option('--workers', 1))))
await Promise.all(Array.from({length: workers}, (_, i) => collect(work.filter((_, j) => j % workers === i))))
{
  const manifest = { sourceUrl: 'https://dashboard.earlylearning.ubc.ca/', capture: release, inventorySha256: createHash('sha256').update(JSON.stringify(regions)).digest('hex'), requestedRegions: work.length, searchRegionCount, inventoryRegions: regions.length, completed, failures, complete: completed === regions.length && failures.length === 0, redistributable: false }
  atomic(join(cache, 'capture.json'), manifest)
  writeFileSync(join(cache, 'capture.json.gz'), gzipSync(JSON.stringify(manifest), { level: 9 }))
  console.log(JSON.stringify(manifest))
  if (failures.length) process.exitCode = 1
}
