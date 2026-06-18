import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import zlib from 'node:zlib'

const root = dirname(fileURLToPath(import.meta.url))
const output = join(root, 'output')
const baseUrl = 'https://maps.fpcc.ca'

const apiResources = [
  ['language-geo.geojson', '/api/language-geo/'],
  ['community-geo.geojson', '/api/community-geo/'],
  ['placename-geo.geojson', '/api/placename-geo/'],
  ['grants.geojson', '/api/grants/'],
]

function byteSummary(buffer) {
  return {
    bytes: buffer.length,
    gzipBytes: zlib.gzipSync(buffer).length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

async function fetchBuffer(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
      'user-agent': 'PGMaps bcdatamapper fpcc snapshot',
    },
  })

  if (!response.ok) {
    throw new Error(`Failed ${url}: ${response.status} ${response.statusText}`)
  }

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type'),
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
  }
}

function extractNuxtState(html) {
  const match = html.match(/window\.__NUXT__=([\s\S]*?)<\/script>/)
  if (!match) {
    throw new Error('Could not find window.__NUXT__ payload in FPCC page')
  }

  const sandbox = { window: {} }
  vm.createContext(sandbox)
  vm.runInContext(
    `window.__NUXT__=${match[1].replace(/;\s*$/, '')}`,
    sandbox,
    { timeout: 10_000 },
  )

  return sandbox.window.__NUXT__
}

function featureCount(value) {
  if (value?.type === 'FeatureCollection' && Array.isArray(value.features)) {
    return value.features.length
  }
  return null
}

async function writeJson(relativePath, value) {
  const buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  const file = join(output, relativePath)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, buffer)
  return byteSummary(buffer)
}

async function main() {
  await mkdir(output, { recursive: true })

  const manifest = {
    source: {
      name: "First Peoples' Map of B.C.",
      homepage: baseUrl,
      fetchedAt: new Date().toISOString(),
    },
    files: {},
    counts: {},
  }

  const page = await fetchBuffer(`${baseUrl}/`)
  await writeFile(join(output, 'source-page.html'), page.buffer)
  manifest.files['source-page.html'] = {
    url: `${baseUrl}/`,
    contentType: page.contentType,
    etag: page.etag,
    ...byteSummary(page.buffer),
  }

  const html = page.buffer.toString('utf8')
  const nuxt = extractNuxtState(html)
  manifest.files['nuxt-state.json'] = await writeJson('nuxt-state.json', nuxt)

  const state = nuxt.state ?? {}
  const stateModules = [
    'app',
    'arts',
    'communities',
    'grants',
    'languages',
    'layers',
    'places',
  ]

  for (const moduleName of stateModules) {
    if (Object.hasOwn(state, moduleName)) {
      manifest.files[`state/${moduleName}.json`] = await writeJson(
        `state/${moduleName}.json`,
        state[moduleName],
      )
    }
  }

  for (const [fileName, path] of apiResources) {
    const url = `${baseUrl}${path}`
    const response = await fetchBuffer(url)
    await writeFile(join(output, fileName), response.buffer)
    const parsed = JSON.parse(response.buffer.toString('utf8'))
    manifest.files[fileName] = {
      url,
      contentType: response.contentType,
      etag: response.etag,
      lastModified: response.lastModified,
      featureCount: featureCount(parsed),
      ...byteSummary(response.buffer),
    }
  }

  manifest.counts = {
    communities: state.communities?.communities?.length ?? null,
    communitySearchRecords: state.communities?.communitySearchSet?.length ?? null,
    languages: state.languages?.languageSet?.length ?? null,
    languageFamilies: Object.fromEntries(
      Object.entries(state.languages?.languages ?? {}).map(([name, entries]) => [
        name,
        Array.isArray(entries) ? entries.length : null,
      ]),
    ),
    artsSearchRecords: state.arts?.artsSearchSet?.length ?? null,
    artsGeoFeatures: state.arts?.artsGeoSet?.features?.length ?? null,
    artsTaxonomyRecords: state.arts?.taxonomySearchSet?.length ?? null,
    grantRecords: state.grants?.grantsSet?.length ?? null,
    grantGeoFeatures: state.grants?.grantsGeo?.features?.length ?? null,
    grantCategoryRecords: state.grants?.categorySearchSet?.length ?? null,
    placenameSearchRecords: state.places?.placeSearchSet?.length ?? null,
    layers: state.layers?.layers?.length ?? null,
  }

  manifest.files['manifest.json'] = await writeJson('manifest.json', manifest)

  console.log(
    `[fpcc] wrote ${Object.keys(manifest.files).length} files -> ${output}`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
