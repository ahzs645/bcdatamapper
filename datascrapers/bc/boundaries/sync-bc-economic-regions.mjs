import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { simplifyPolygonTopology, TOPOLOGY_PROFILES } from '../../lib/mapshaper-topology.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const sourceDir = join(here, 'source/StatCanEconomicRegions')
const outputDir = join(here, 'output/StatCan')
execFileSync('python3', [join(here, 'acquire-economic-regions.py'),
  ...(process.argv.includes('--refresh') ? ['--refresh'] : [])], { stdio: 'inherit' })
const readSource = name => JSON.parse(gunzipSync(readFileSync(join(sourceDir, name))))
const hierarchy = readSource('sgc_2021_hierarchy.json.gz')
const sourceBytes = readFileSync(join(sourceDir, 'bc_economic_regions_2021.full.geojson.gz'))
const source = JSON.parse(gunzipSync(sourceBytes))
const names = new Map(hierarchy.economicRegions.map(r => [r.code, r.name]))
const features = source.features.map(f => {
  const p = f.properties
  const code = String(p.ERUID)
  if (!names.has(code) || p.PRUID !== '59') throw new Error(`Unexpected region ${code}`)
  return { type: 'Feature', id: code, geometry: f.geometry, properties: {
    boundaryCode: code, boundaryName: names.get(code), ERUID: code, ERNAME: p.ERNAME,
    DGUID: p.DGUID, PRUID: p.PRUID, censusYear: 2021, sourceLandAreaKm2: p.LANDAREA,
    censusDivisionCodes: hierarchy.censusDivisions.filter(d => d.economicRegionCode === code).map(d => d.code),
  } }
}).sort((a, b) => a.id.localeCompare(b.id))
if (features.length !== 8 || new Set(features.map(f => f.id)).size !== 8) throw new Error('Expected eight unique regions')
// 50 m is suitable for province/regional display; retain full source for detailed analysis.
const output = simplifyPolygonTopology({ type: 'FeatureCollection', features }, {
  sourceCrs: 'EPSG:4326', workingCrs: 'EPSG:3005', outputCrs: 'EPSG:4326',
  toleranceMetres: 50, coordinatePrecision: 8, topologyProfile: TOPOLOGY_PROFILES.PARTITION,
  tempPrefix: 'bc-economic-regions-',
})
output.name = 'British Columbia economic regions, 2021'
output.metadata = { ...output.metadata,
  source: 'Statistics Canada',
  sourceUrl: 'https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Digital_boundary_files/MapServer/2',
  sourceLayer: 2, sourceNativeCrs: 'EPSG:3347', censusYear: 2021,
  boundarySetId: 'statcan-economic-regions-2021-bc', coverage: 'British Columbia',
  licence: 'Statistics Canada Open Licence', licenceUrl: 'https://www.statcan.gc.ca/en/reference/licence',
  hierarchyFile: 'bc_economic_regions_2021.hierarchy.json',
  sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
  caveat: 'Statistical regions, not NDIT service regions. Digital boundaries include water. Display geometry is simplified at 50 m; source land area is retained separately.',
}
const payload = Buffer.from(`${JSON.stringify(output)}\n`)
const compressed = gzipSync(payload, { level: 9, mtime: 0 })
mkdirSync(outputDir, { recursive: true })
writeFileSync(join(outputDir, 'bc_economic_regions_2021.geojson.gz'), compressed)
const writeJson = (name, value) => writeFileSync(join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`)
writeJson('bc_economic_regions_2021.hierarchy.json', { ...hierarchy,
  levels: ['province', 'economicRegion', 'censusDivision', 'censusSubdivision'],
  relationship: 'Official SGC 2021 classification membership, not spatial inference',
  caveats: ['Census divisions include regional districts and statistical equivalents.',
    'Census subdivisions include municipalities, electoral areas, reserves and other municipal equivalents.',
    'Use matching 2021 geography; current administrative boundaries can differ.',
    'NDIT service regions cut across this hierarchy and are not children of economic regions.'],
  dashboardEconomicRegionGroups: [
    { code: 'cariboo', name: 'Cariboo', economicRegionCodes: ['5950'] },
    { code: 'north-coast-nechako', name: 'North Coast and Nechako', economicRegionCodes: ['5960', '5970'] },
    { code: 'northeast', name: 'Northeast', economicRegionCodes: ['5980'] },
  ],
})
const manifest = { ...output.metadata, file: 'bc_economic_regions_2021.geojson.gz', features: 8,
  rawGeojsonBytes: gunzipSync(sourceBytes).length, optimizedGeojsonBytes: payload.length,
  gzipBytes: compressed.length, sha256: createHash('sha256').update(compressed).digest('hex'),
  censusDivisions: hierarchy.censusDivisions.length, censusSubdivisions: hierarchy.censusSubdivisions.length,
}
writeJson('bc_economic_regions_2021.manifest.json', manifest)
console.log(JSON.stringify(manifest, null, 2))
