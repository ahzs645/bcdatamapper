import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const CITYPG_BUSINESS_LICENCE_LAYER =
  'https://services2.arcgis.com/CnkB6jCzAsyli34z/arcgis/rest/services/Business_License/FeatureServer/0'

const CITYPG_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(CITYPG_DIR, 'source', 'business-licences')
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'business_licences_detailed.json')
const OUTPUT_MANIFEST = path.join(OUTPUT_DIR, 'manifest.json')
const PAGE_SIZE = 1000
const OUT_FIELDS = 'LicenceNumber,DateFrom,DateTo,TradeName,LicenceDesc,LicenceCategory,Unit,Address,StreeName'

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'PGMaps bcdatamapper CityPG scraper' },
  })
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`)
  return response.json()
}

export async function fetchCityPgBusinessLicences() {
  const rows = []
  let offset = 0

  while (true) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: OUT_FIELDS,
      returnGeometry: 'false',
      f: 'json',
      resultRecordCount: String(PAGE_SIZE),
      resultOffset: String(offset),
    })
    const data = await fetchJson(`${CITYPG_BUSINESS_LICENCE_LAYER}/query?${params.toString()}`)
    const features = data.features ?? []
    rows.push(...features.map((feature) => feature.attributes ?? {}))
    if (features.length < PAGE_SIZE) break
    offset += features.length
  }

  return rows
}

export async function syncCityPgBusinessLicences() {
  const rows = await fetchCityPgBusinessLicences()
  const generatedAt = new Date().toISOString()
  await mkdir(OUTPUT_DIR, { recursive: true })
  await writeFile(OUTPUT_JSON, `${JSON.stringify(rows)}\n`)
  await writeFile(
    OUTPUT_MANIFEST,
    `${JSON.stringify(
      {
        generatedAt,
        source: {
          name: 'City of Prince George Business License',
          url: CITYPG_BUSINESS_LICENCE_LAYER,
          fields: OUT_FIELDS.split(','),
        },
        outputs: {
          businessLicencesDetailed: path.relative(CITYPG_DIR, OUTPUT_JSON).split(path.sep).join('/'),
        },
        rowCount: rows.length,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`CityPG detailed business licences: ${rows.length}`)
  console.log(`Wrote ${OUTPUT_JSON}`)
  return rows
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncCityPgBusinessLicences().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
