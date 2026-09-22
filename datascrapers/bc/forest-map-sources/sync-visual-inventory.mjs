import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync, gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

const root = dirname(fileURLToPath(import.meta.url))
const cache = join(root, 'source/visual-inventory')
const output = join(root, 'output/visual-inventory')
const service = 'https://delivery.maps.gov.bc.ca/arcgis/rest/services/whse/bcgw_pub_whse_forest_vegetation/MapServer/6'
const fields = 'OBJECTID,VLI_POLYGON_NO,REC_EVQO_CODE,REC_RVQC_CODE,REC_VAC_FINAL_VALUE_CODE,REC_VSC_FINAL_VALUE_CODE,SCENIC_AREA_IND,RATIONALE,UPDATE_DATE'
mkdirSync(cache, { recursive: true }); mkdirSync(output, { recursive: true })
async function query(params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${service}/query?${new URLSearchParams({ f: 'json', ...params })}`, { signal: AbortSignal.timeout(120000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = await response.json()
      if (json.error) throw new Error(JSON.stringify(json.error))
      return json
    } catch (error) { if (attempt === 2) throw error }
  }
}
const ids = (await query({ where: '1=1', returnIdsOnly: 'true' })).objectIds.sort((a, b) => a - b)
const count = (await query({ where: '1=1', returnCountOnly: 'true' })).count
if (ids.length !== count || new Set(ids).size !== count) throw new Error('Incomplete or duplicate source identifiers')
const features = [], pages = []
let next = 0
await Promise.all(Array.from({ length: 4 }, async () => {
while (next < ids.length) {
  const start = next; next += 200
  const batch = ids.slice(start, start + 200)
  const path = join(cache, `${createHash('sha256').update(JSON.stringify(batch)).digest('hex').slice(0, 16)}.geojson.gz`)
  pages.push(path.slice(cache.length + 1))
  const useCache = existsSync(path) && !process.argv.includes('--refresh')
  const data = useCache ? JSON.parse(gunzipSync(readFileSync(path))) : await query({ objectIds: batch.join(','), outFields: fields, returnGeometry: 'true', outSR: '4326', f: 'geojson' })
  if (data.features?.length !== batch.length || data.features.some(f => !batch.includes(f.properties.OBJECTID))) throw new Error(`Incomplete page at ${start}`)
  if (!useCache) writeFileSync(path, gzipSync(JSON.stringify(data), { level: 9 }))
  features.push(...data.features)
  console.log(`Downloaded ${features.length}/${count}`)
}
}))
if (new Set(features.map(f => f.properties.OBJECTID)).size !== count) throw new Error('Duplicate source features')
writeFileSync(join(cache, 'source-pages.json'), JSON.stringify(pages.sort()))
features.sort((a, b) => a.properties.OBJECTID - b.properties.OBJECTID)
const source = { type: 'FeatureCollection', features }
const rawBytes = Buffer.byteLength(JSON.stringify(source))
// Keep source geometry exactly. A trial 30 m simplification distorted small
// units; spatial shards make full-resolution boundaries practical instead.
const bounds = geometry => {
  const b = [Infinity, Infinity, -Infinity, -Infinity]
  const visit = a => { if (typeof a[0] === 'number') { b[0] = Math.min(b[0], a[0]); b[1] = Math.min(b[1], a[1]); b[2] = Math.max(b[2], a[0]); b[3] = Math.max(b[3], a[1]) } else a.forEach(visit) }
  visit(geometry.coordinates); return b
}
const sorted = features.map(feature => ({ feature, bbox: bounds(feature.geometry) }))
  .sort((a,b) => Math.floor(a.bbox[1]) - Math.floor(b.bbox[1]) || Math.floor(a.bbox[0]) - Math.floor(b.bbox[0]) || a.feature.properties.OBJECTID - b.feature.properties.OBJECTID)
const shards = [], index = []
rmSync(join(output, 'inventory.geojson.gz'), { force: true })
for (let start = 0; start < sorted.length; start += 100) {
  const rows = sorted.slice(start, start + 100), file = `units-${String(start / 100).padStart(3, '0')}.geojson.gz`
  const bytes = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: rows.map(r => r.feature) }))
  const compressed = gzipSync(bytes, { level: 9 })
  if (compressed.length > 20 * 1024 * 1024) throw new Error(`Shard too large: ${file}`)
  writeFileSync(join(output, file), compressed)
  shards.push({ file, featureCount: rows.length, gzipBytes: compressed.length, sha256: createHash('sha256').update(compressed).digest('hex') })
  index.push(...rows.map(r => ({ id: String(r.feature.properties.OBJECTID), bbox: r.bbox, shard: file })))
}
writeFileSync(join(output, 'index.json.gz'), gzipSync(JSON.stringify(index), { level: 9 }))
const stampPath = join(cache, 'retrieved-at.json')
if (!existsSync(stampPath) || process.argv.includes('--refresh')) writeFileSync(stampPath, JSON.stringify(new Date().toISOString()))
const gzipBytes = shards.reduce((n,s) => n + s.gzipBytes, 0)
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ schemaVersion: 2, retrievedAt: JSON.parse(readFileSync(stampPath)), source: service, sourceCrs: 'EPSG:4326', outputCrs: 'EPSG:4326', featureCount: count, sourceLatestUpdate: Math.max(...features.map(f => Number(f.properties.UPDATE_DATE) || 0)), index: 'index.json.gz', shards, rawBytes, gzipBytes, simplification: { toleranceMetres: 0, algorithm: 'none; original source coordinates preserved' }, license: 'Open Government Licence - British Columbia', licenseUrl: 'https://www2.gov.bc.ca/gov/content/data/open-data/open-government-licence-bc' }, null, 2) + '\n')
console.log(`Saved ${count} full-resolution units: ${(rawBytes / 1e6).toFixed(1)} MB raw, ${(gzipBytes / 1e6).toFixed(1)} MB gzip in ${shards.length} spatial shards`)
