import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import shp from 'shpjs'
import { simplifyPolygonTopology, TOPOLOGY_PROFILES } from '../../lib/mapshaper-topology.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const sourceDir = resolve(here, 'source/StatCanFSA')
const outputDir = resolve(here, 'output/StatCan')
const sourceUrl = 'https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lfsa000b21a_e.zip'
const archivePath = resolve(sourceDir, 'lfsa000b21a_e.zip')
const arg = process.argv.find(value => value.startsWith('--archive='))
const toleranceMetres = 25 // Province-wide overview; preserve small urban FSA shapes.
mkdirSync(sourceDir, { recursive: true })
mkdirSync(outputDir, { recursive: true })
if (!arg && (!existsSync(archivePath) || process.argv.includes('--refresh'))) {
  execFileSync('curl', ['--fail', '--location', '--retry', '3', '--max-time', '600', '-o', `${archivePath}.part`, sourceUrl], { stdio: 'inherit' })
  renameSync(`${archivePath}.part`, archivePath)
}
const zip = readFileSync(arg ? arg.slice('--archive='.length) : archivePath)
const parsed = await shp(zip)
const collections = Array.isArray(parsed) ? parsed : [parsed]
const features = collections.flatMap(collection => collection.features)
  .filter(feature => String(feature.properties.PRUID) === '59')
  .map(feature => {
    const p = feature.properties
    const code = String(p.CFSAUID)
    if (!/^V\d[A-Z]$/.test(code)) throw new Error(`Unexpected BC FSA: ${code}`)
    return { type: 'Feature', id: code, geometry: feature.geometry, properties: {
      boundaryCode: code, boundaryName: `FSA ${code}`, CFSAUID: code, DGUID: p.DGUID,
      PRUID: '59', censusYear: 2021, sourceLandAreaKm2: Number(p.LANDAREA),
    } }
  }).sort((a,b) => a.id.localeCompare(b.id))
if (features.length !== 191 || new Set(features.map(f => f.id)).size !== 191) throw new Error('Expected 191 unique 2021 BC FSAs')
const raw = { type: 'FeatureCollection', features }
const rawPayload = Buffer.from(`${JSON.stringify(raw)}\n`)
// Cache the complete source-derived geometry for validation; not a deployed duplicate.
writeFileSync(resolve(sourceDir, 'bc_fsa_2021_full.geojson'), rawPayload)
const optimized = simplifyPolygonTopology(raw, {
  sourceCrs: 'EPSG:4326', workingCrs: 'EPSG:3005', outputCrs: 'EPSG:4326',
  toleranceMetres, coordinatePrecision: 8, topologyProfile: TOPOLOGY_PROFILES.PARTITION,
  tempPrefix: 'statcan-fsa-',
})
optimized.name = 'British Columbia census forward sortation areas, 2021'
optimized.metadata = { ...optimized.metadata,
  source: 'Statistics Canada', sourceUrl, sourceArchiveCrs: 'EPSG:3347',
  archiveSha256: createHash('sha256').update(zip).digest('hex'),
  boundarySetId: 'statcan-cfsa-2021-bc', censusYear: 2021, coverage: 'British Columbia',
  referenceGuide: 'https://www150.statcan.gc.ca/n1/pub/92-179-g/92-179-g2021001-eng.htm',
  caveat: 'Census-reported three-character postal areas; not six-character Canada Post delivery boundaries. Display geometry simplified at 25 m. Source area is retained separately.',
}
const payload = Buffer.from(`${JSON.stringify(optimized)}\n`)
const compressed = gzipSync(payload, { level: 9, mtime: 0 })
const file = 'bc_fsa_2021.geojson.gz'
writeFileSync(resolve(outputDir, file), compressed)
const manifest = { ...optimized.metadata, file, features: features.length,
  archiveBytes: zip.length, rawBcGeojsonBytes: rawPayload.length,
  optimizedGeojsonBytes: payload.length, gzipBytes: compressed.length,
  sha256: createHash('sha256').update(compressed).digest('hex'),
}
writeFileSync(resolve(outputDir, 'bc_fsa_2021.manifest.json'), `${JSON.stringify(manifest,null,2)}\n`)
console.log(JSON.stringify(manifest,null,2))
