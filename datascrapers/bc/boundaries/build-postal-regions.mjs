import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync, gunzipSync } from 'node:zlib'
import { MAPSHAPER_VERSION } from '../../lib/mapshaper-topology.mjs'

// A defined parent of the existing display FSAs, with no second simplification.
// Keep its source version tied to the FSA layer; never rebuild it independently
// from a different postal release.
export function buildPostalRegions(outputDir) {
  const fsaBytes = readFileSync(join(outputDir, 'bc_fsa_2021.geojson.gz'))
  const fsa = JSON.parse(gunzipSync(fsaBytes))
  const temp = mkdtempSync(join(tmpdir(), 'postal-region-'))
  try {
    const input = join(temp, 'input.geojson'), output = join(temp, 'output.geojson')
    const features = fsa.features.map(f => ({ ...f, properties: { boundaryCode: f.properties.CFSAUID[0] } }))
    writeFileSync(input, JSON.stringify({ type: 'FeatureCollection', features }))
    execFileSync('npx', ['--yes', '--package', `mapshaper@${MAPSHAPER_VERSION}`, '--', 'mapshaper', input,
      '-dissolve', 'boundaryCode', '-o', 'format=geojson', 'precision=0.00000001', output], { stdio: 'inherit' })
    const collection = JSON.parse(readFileSync(output))
    if (collection.features.length !== 1 || collection.features[0].properties.boundaryCode !== 'V') throw new Error('Expected BC postal region V')
    collection.features[0].id = 'V'
    Object.assign(collection.features[0].properties, { boundaryName: 'British Columbia postal region (V)',
      postalRegionCode: 'V', censusYear: 2021, childLevel: 'fsa', childCount: fsa.features.length })
    collection.metadata = { boundarySetId: 'statcan-cfsa-2021-bc', level: 'postalRegion',
      sourceArchiveSha256: fsa.metadata.archiveSha256,
      childFile: 'bc_fsa_2021.geojson.gz', childSha256: createHash('sha256').update(fsaBytes).digest('hex'),
      method: 'Dissolve shared FSA display geometry by first postal-code character; no additional simplification',
      mapshaperVersion: MAPSHAPER_VERSION, outputCrs: 'EPSG:4326',
      caveat: 'PGMaps-defined postal parent derived from census FSAs; not a separate Canada Post delivery boundary release.' }
    const payload = Buffer.from(`${JSON.stringify(collection)}\n`), compressed = gzipSync(payload, { level: 9, mtime: 0 })
    writeFileSync(join(outputDir, 'bc_postal_region_2021.geojson.gz'), compressed)
    const manifest = { ...collection.metadata, features: 1, geojsonBytes: payload.length, gzipBytes: compressed.length,
      sha256: createHash('sha256').update(compressed).digest('hex') }
    writeFileSync(join(outputDir, 'bc_postal_region_2021.manifest.json'), `${JSON.stringify(manifest,null,2)}\n`)
    return manifest
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(buildPostalRegions(join(dirname(fileURLToPath(import.meta.url)), 'output/StatCan')),null,2))
}
