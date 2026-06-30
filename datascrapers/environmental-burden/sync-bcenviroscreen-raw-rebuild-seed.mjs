#!/usr/bin/env node

import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output', 'bc-enviro-screen', 'raw-rebuild-seed')
const COMPACT_DIR = path.join(OUTPUT_DIR, 'compact')
const LARGE_DIR = path.join(OUTPUT_DIR, 'large')
const PGMAPS_ROOT = process.env.PGMAPS_ROOT ? path.resolve(process.env.PGMAPS_ROOT) : path.resolve(SCRIPT_DIR, '..', '..', '..', '..')

const USER_AGENT = 'PGMaps BCEnviroScreen raw rebuild seed downloader'
const BC_CATALOG_API = 'https://catalogue.data.gov.bc.ca/api/3/action/package_show'
const CANADA_CATALOG_API = 'https://open.canada.ca/data/api/action/package_show'
const CANUE_BASE = 'https://data.map.ahmad.sh/canue'

const args = parseArgs(process.argv.slice(2))
const overwrite = args.overwrite === 'true'
const downloadLarge = args['download-large'] === 'true'
const largeIds = new Set(String(args['large-ids'] ?? '').split(',').map((value) => value.trim()).filter(Boolean))
const largeResourcePattern = args['large-resource-pattern'] ? new RegExp(args['large-resource-pattern'], 'i') : null

const CANUE_DOWNLOADS = [
  {
    id: 'canue-bc-grid-v2-app-catalog',
    group: 'canue',
    url: `${CANUE_BASE}/pmtiles-v2/canue-bc-grid-v2-app-catalog.json`,
    output: 'canue/canue-bc-grid-v2-app-catalog.json',
  },
  {
    id: 'canue-bc-grid-v2-metadata',
    group: 'canue',
    url: `${CANUE_BASE}/pmtiles-v2/canue-bc-grid-v2-metadata.json`,
    output: 'canue/canue-bc-grid-v2-metadata.json',
  },
  {
    id: 'canue-bc-aggregates-v2-catalog',
    group: 'canue',
    url: `${CANUE_BASE}/aggregates-v2/canue-bc-aggregates-v2-catalog.json`,
    output: 'canue/canue-bc-aggregates-v2-catalog.json',
  },
  {
    id: 'canue-lha-air-quality-2012',
    group: 'canue',
    url: `${CANUE_BASE}/aggregates-v2/bcHealth/lha/air-quality_2012_aggregate.json`,
    output: 'canue/bcHealth/lha/air-quality_2012_aggregate.json',
    enviroScreenUse: 'Paper PM2.5 input: annual mean concentration in 2012, summarized to BC LHAs.',
  },
  {
    id: 'canue-lha-air-quality-2015',
    group: 'canue',
    url: `${CANUE_BASE}/aggregates-v2/bcHealth/lha/air-quality_2015_aggregate.json`,
    output: 'canue/bcHealth/lha/air-quality_2015_aggregate.json',
    enviroScreenUse: 'Paper ozone input: annual mean concentration in 2015, summarized to BC LHAs.',
  },
]

const BC_PACKAGES = [
  {
    id: 'local-health-area-boundaries',
    catalog: 'bc',
    packageId: 'local-health-area-boundaries',
    enviroScreenUse: 'BC LHA geography and all-BC comparison universe.',
  },
  {
    id: 'bc-human-disturbance-2025',
    catalog: 'bc',
    packageId: '7d61ff12-b85f-4aeb-ac8b-7b10e84b046c',
    enviroScreenUse: 'Modern disturbed-land rebuild input; paper used intact forest land percent from Potapov et al. 2008.',
  },
  {
    id: 'bc-cef-integrated-roads-2026',
    catalog: 'bc',
    packageId: 'a489bc6a-f676-4503-8cd7-dcf0bdf2ae99',
    enviroScreenUse: 'Modern linear-footprint rebuild input; paper assembled forest roads, rail, DRA, transmission and seismic lines.',
  },
  {
    id: 'bc-environmental-monitoring-system-results',
    catalog: 'bc',
    packageId: '949f2233-9612-4b06-92a9-903e817da659',
    enviroScreenUse: 'Water exceedance rebuild input for lead, E. coli, nitrate, mercury, phosphorus and TOC thresholds.',
  },
  {
    id: 'bc-environmental-remediation-sites',
    catalog: 'bc',
    packageId: '63804e64-a4f3-4bc7-b1e3-5f736bbc3967',
    enviroScreenUse: 'Remediation site count by LHA.',
  },
  {
    id: 'bc-wildfire-historical-fire-perimeters',
    catalog: 'bc',
    packageId: '22c7cb44-1463-48f7-8e47-88857f207702',
    enviroScreenUse: 'Wildfire burn-area percent, especially 2010-2019 for paper compatibility.',
  },
  {
    id: 'bc-major-timber-processing-facilities',
    catalog: 'bc',
    packageId: '67daf53d-e3bb-45ee-9121-8aa1193b7492',
    enviroScreenUse: 'Forestry mill count by LHA.',
  },
  {
    id: 'bc-permitted-mine-areas-major-mine',
    catalog: 'bc',
    packageId: '01e8a35e-35e3-4b48-93a7-b0d7c9705b62',
    enviroScreenUse: 'Mine count/area by LHA, with producing/major-mine filtering still to be validated.',
  },
  {
    id: 'bc-oil-and-gas-fields',
    catalog: 'bc',
    packageId: '450a1faf-13e0-40c3-9fcf-8864b3714963',
    enviroScreenUse: 'Oil and gas field count/area by LHA.',
  },
]

const CANADA_PACKAGES = [
  {
    id: 'npri-bulk-data',
    catalog: 'canada',
    packageId: '40e01423-7728-429c-ac9d-2954385ccdfb',
    enviroScreenUse: 'Industrial release/reported facility inputs for BC-wide LHA summaries.',
    directLargeResources: [
      'NPRI-INRP_ReleasesRejets_1993-present.csv',
      'NPRI-INRP_DisposalsEliminations_1993-present.csv',
      'NPRI-INRP_DisposalsEliminations_TransfersTransferts_1993-present.csv',
      'NPRI-INRP_GeolocationsGeolocalisation_1993-present.csv',
      'NPRI-INRP_CommentsCommentaires_1997-present.csv',
    ].map((name) => ({
      name,
      format: 'csv',
      url: `https://data-donnees.az.ec.gc.ca/api/file?path=/substances/plansreports/reporting-facilities-pollutant-release-and-transfer-data/bulk-data-files-for-all-years-releases-disposals-transfers-and-facility-locations/${name}`,
    })),
  },
]

const LOCAL_COPIES = [
  {
    id: 'bc-health-lha-boundaries-local',
    source: 'public/data/boundaries/BCMoH/local_health_areas.json',
    output: 'boundaries/BCMoH/local_health_areas.json',
    enviroScreenUse: 'Local copy of BC LHA boundaries for all-BC spatial rollups.',
  },
  {
    id: 'bc-health-lha-boundaries-simplified-local',
    source: 'public/data/boundaries/BCMoH/simplified/local_health_areas.json',
    output: 'boundaries/BCMoH/simplified/local_health_areas.json',
    enviroScreenUse: 'Simplified LHA boundaries for fast tests and QA maps.',
  },
  {
    id: 'official-shiny-lha-indicators',
    source: 'vendor/bcdatamapper/datascrapers/environmental-burden/output/bc-enviro-screen/official-shiny-table/lha-indicators.csv',
    output: 'benchmark/official-shiny-lha-indicators.csv',
    optional: true,
    enviroScreenUse: 'Official displayed Shiny app target table for validation.',
  },
  {
    id: 'official-shiny-lha-indicators-json',
    source: 'vendor/bcdatamapper/datascrapers/environmental-burden/output/bc-enviro-screen/official-shiny-table/lha-indicators.json',
    output: 'benchmark/official-shiny-lha-indicators.json',
    optional: true,
    enviroScreenUse: 'Official displayed Shiny app target table for validation.',
  },
]

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) parsed[key] = 'true'
    else {
      parsed[key] = next
      index += 1
    }
  }
  return parsed
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
  if (!response.ok) throw new Error(`Failed ${response.status} ${response.statusText}: ${url}`)
  return response.json()
}

function packageUrl(source) {
  const url = new URL(source.catalog === 'canada' ? CANADA_CATALOG_API : BC_CATALOG_API)
  url.searchParams.set('id', source.packageId)
  return url.toString()
}

function normalizeResource(resource) {
  return {
    id: resource.id,
    name: resource.name,
    format: resource.format,
    url: resource.url || null,
    sizeBytes: Number(resource.size) || null,
    lastModified: resource.last_modified ?? null,
    accessMethod: resource.resource_access_method ?? null,
    storageLocation: resource.resource_storage_location ?? null,
  }
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function resourceExtension(format) {
  const normalized = String(format || 'bin').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'bin'
  return normalized === 'fgdb' ? 'fgdb.zip' : normalized
}

async function downloadFile(item, baseDir) {
  const outputPath = path.join(baseDir, item.output)
  if (!overwrite) {
    try {
      const existing = await stat(outputPath)
      return { ...item, outputPath: path.relative(OUTPUT_DIR, outputPath), bytes: existing.size, skippedExisting: true }
    } catch {
      // Continue to download.
    }
  }

  await mkdir(path.dirname(outputPath), { recursive: true })
  const response = await fetch(item.url, { redirect: 'follow', headers: { 'user-agent': USER_AGENT } })
  if (!response.ok) throw new Error(`Failed download ${response.status}: ${item.url}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(outputPath))
  const written = await stat(outputPath)
  return {
    ...item,
    outputPath: path.relative(OUTPUT_DIR, outputPath),
    bytes: written.size,
    contentType: response.headers.get('content-type'),
    sourceContentLength: Number(response.headers.get('content-length')) || null,
  }
}

async function copyLocal(item) {
  const sourcePath = path.join(PGMAPS_ROOT, item.source)
  const outputPath = path.join(COMPACT_DIR, item.output)
  try {
    if (!overwrite) {
      const existing = await stat(outputPath)
      return { ...item, outputPath: path.relative(OUTPUT_DIR, outputPath), bytes: existing.size, skippedExisting: true }
    }
  } catch {
    // Continue.
  }

  try {
    await mkdir(path.dirname(outputPath), { recursive: true })
    await copyFile(sourcePath, outputPath)
    const written = await stat(outputPath)
    return { ...item, outputPath: path.relative(OUTPUT_DIR, outputPath), bytes: written.size }
  } catch (error) {
    if (item.optional) return { ...item, missingOptional: true, error: error.message }
    throw error
  }
}

async function writePackageMetadata(source) {
  const pkg = await fetchJson(packageUrl(source))
  if (pkg.success === false) throw new Error(`Catalogue API failed for ${source.packageId}`)
  const result = pkg.result
  const outputPath = path.join(COMPACT_DIR, 'catalog', source.catalog, `${source.id}.json`)
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`)

  const resources = (result.resources ?? []).map(normalizeResource)
  const compactResources = resources.filter((resource) => {
    const format = String(resource.format ?? '').toLowerCase()
    const size = resource.sizeBytes ?? Infinity
    return resource.url && ['pdf', 'xlsx', 'csv', 'json'].includes(format) && size <= 5_000_000
  })

  const compactDownloads = []
  for (const resource of compactResources) {
    compactDownloads.push(await downloadFile({
      id: `${source.id}-${resource.id ?? slugify(resource.name)}`,
      group: `catalog/${source.id}`,
      url: resource.url,
      output: `catalog-resources/${source.id}/${slugify(resource.name || resource.id)}.${String(resource.format || 'bin').toLowerCase()}`,
      resource,
    }, COMPACT_DIR))
  }

  return {
    ...source,
    title: result.title,
    catalogUrl: source.catalog === 'canada'
      ? `https://open.canada.ca/data/en/dataset/${source.packageId}`
      : `https://catalogue.data.gov.bc.ca/dataset/${result.name ?? source.packageId}`,
    metadataOutputPath: path.relative(OUTPUT_DIR, outputPath),
    resources,
    compactDownloads,
  }
}

async function maybeDownloadLargeResources(packageSummaries) {
  if (!downloadLarge) return []

  const largeItems = []
  for (const summary of packageSummaries) {
    if (largeIds.size > 0 && !largeIds.has(summary.id)) continue
    if (summary.directLargeResources) {
      for (const resource of summary.directLargeResources) {
        if (largeResourcePattern && !largeResourcePattern.test(resource.name)) continue
        largeItems.push({
          id: `${summary.id}-${slugify(resource.name)}`,
          group: summary.id,
          url: resource.url,
          output: `${summary.id}/${resource.name}`,
        })
      }
      continue
    }

    for (const resource of summary.resources ?? []) {
      const format = String(resource.format ?? '').toLowerCase()
      if (!resource.url || !['fgdb', 'zip', 'csv'].includes(format)) continue
      if ((resource.sizeBytes ?? 0) > 0 && resource.sizeBytes <= 5_000_000) continue
      if (largeResourcePattern && !largeResourcePattern.test(resource.name || resource.id || resource.url)) continue
      largeItems.push({
        id: `${summary.id}-${resource.id ?? slugify(resource.name)}`,
        group: summary.id,
        url: resource.url,
        output: `${summary.id}/${slugify(resource.name || resource.id)}.${resourceExtension(format)}`,
      })
    }
  }

  const downloads = []
  for (const item of largeItems) {
    console.log(`large: ${item.id}`)
    downloads.push(await downloadFile(item, LARGE_DIR))
  }
  return downloads
}

async function main() {
  await mkdir(COMPACT_DIR, { recursive: true })

  const localCopies = []
  for (const item of LOCAL_COPIES) {
    localCopies.push(await copyLocal(item))
  }

  const canueDownloads = []
  for (const item of CANUE_DOWNLOADS) {
    console.log(`canue: ${item.id}`)
    canueDownloads.push(await downloadFile(item, COMPACT_DIR))
  }

  const packageSummaries = []
  for (const source of [...BC_PACKAGES, ...CANADA_PACKAGES]) {
    console.log(`catalog: ${source.id}`)
    const summary = await writePackageMetadata(source)
    if (source.directLargeResources) summary.directLargeResources = source.directLargeResources
    packageSummaries.push(summary)
  }

  const largeDownloads = await maybeDownloadLargeResources(packageSummaries)

  const manifest = {
    generatedAt: new Date().toISOString(),
    validationTarget: 'https://planetaryhealth.shinyapps.io/BC_Enviro_Screen/',
    note: 'This seed folder stages local inputs for rebuilding BCEnviroScreen indicators and validating recreated values against the Shiny app table.',
    mode: downloadLarge ? 'compact-plus-large' : 'compact',
    outputDir: OUTPUT_DIR,
    localCopies,
    canueDownloads,
    packageSummaries,
    largeDownloads,
    largeDownloadHint: downloadLarge
      ? null
      : 'Run with --download-large true to stream FileGDB, EMS CSV, and NPRI CSV packages into large/. These can require many GB.',
  }

  await writeFile(path.join(OUTPUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`BCEnviroScreen raw rebuild seed wrote ${path.relative(PGMAPS_ROOT, OUTPUT_DIR)}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
