import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { chromium } from 'playwright'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const CACHE_ROOT = join(SCRIPT_DIR, 'cache')
const OUTPUT_PATH = join(CACHE_ROOT, 'dashboard_mcfd_local_service_areas.geojson')
const DASHBOARD_URL = 'https://dashboard.earlylearning.ubc.ca/'
const DASHBOARD_STATE_URL = `${DASHBOARD_URL}?_inputs_&boundarySelector=%22LSA%22&regionSelector=%22LSA_2528%22&caseSelector=%22LSA_2528_9%22&scalesScaleSelector=%22overall%22&introjs-dontShowAgain=true`

function sha256(payload) {
  return createHash('sha256').update(payload).digest('hex')
}

function gzipDeterministic(payload) {
  return gzipSync(payload, { level: 9, mtime: 0 })
}

const systemChromePaths = [
  process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)
const systemChrome = systemChromePaths.find((path) => existsSync(path))
const browser = await chromium.launch({
  headless: true,
  ...(systemChrome ? { executablePath: systemChrome } : {}),
})

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.goto(DASHBOARD_STATE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => (
    document.querySelector('#boundarySelector')?.value === 'LSA'
    && document.querySelector('#regionSelector')?.value === 'LSA_2528'
  ), undefined, { timeout: 60_000 })
  const tourDismiss = page.locator('.introjs-skipbutton:visible, .introjs-donebutton:visible, .introjs-close-button:visible').first()
  if (await tourDismiss.count()) await tourDismiss.click({ force: true })
  await page.locator("a[href='#scales']").click()
  try {
    await page.waitForFunction(() => {
      const widget = globalThis.HTMLWidgets?.find?.('#scalesMap')
      const map = widget?.getMap?.()
      if (!map) return false
      return Object.values(map._layers ?? {}).filter((layer) => (
        typeof layer?.options?.layerId === 'string'
        && layer.options.layerId.startsWith('LSA_')
        && typeof layer.toGeoJSON === 'function'
      )).length === 47
    }, undefined, { timeout: 45_000 })
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const map = globalThis.HTMLWidgets?.find?.('#scalesMap')?.getMap?.()
      const ids = Object.values(map?._layers ?? {})
        .map((layer) => layer?.options?.layerId)
        .filter((id) => typeof id === 'string' && id.startsWith('LSA_'))
      return {
        boundary: document.querySelector('#boundarySelector')?.value,
        region: document.querySelector('#regionSelector')?.value,
        scalesDisplay: getComputedStyle(document.querySelector('#scales')).display,
        mapSize: {
          width: document.querySelector('#scalesMap')?.clientWidth,
          height: document.querySelector('#scalesMap')?.clientHeight,
        },
        lsaCount: ids.length,
        includes2528: ids.includes('LSA_2528'),
        includes2529: ids.includes('LSA_2529'),
      }
    })
    throw new Error(`Dashboard LSA map did not reach 47 vector layers: ${JSON.stringify(diagnostics)}`, { cause: error })
  }

  const features = await page.evaluate(() => {
    const map = globalThis.HTMLWidgets.find('#scalesMap').getMap()
    const searchRecords = typeof REGION_SEARCH_DATA === 'undefined' ? [] : REGION_SEARCH_DATA
    const namesByBoundaryAndCode = new Map(searchRecords.map((record) => [
      `${record.boundaryCode}_${record.regionCode}`,
      record.regionName,
    ]))
    namesByBoundaryAndCode.set('LSA_2529', 'Central Coast')
    return Object.values(map._layers)
      .filter((layer) => (
        typeof layer?.options?.layerId === 'string'
        && layer.options.layerId.startsWith('LSA_')
        && typeof layer.toGeoJSON === 'function'
      ))
      .map((layer) => {
        const feature = layer.toGeoJSON()
        const regionId = layer.options.layerId
        const regionCode = regionId.slice(4)
        const serviceDeliveryAreaCode = regionCode.slice(0, 2)
        const mcfdRegionCode = regionCode.slice(0, 1)
        return {
          ...feature,
          id: regionId,
          properties: {
            boundaryCode: 'LSA',
            boundaryName: 'MCFD Local Service Area',
            regionId,
            regionCode,
            regionName: namesByBoundaryAndCode.get(regionId),
            parentRegionId: `SDA_${serviceDeliveryAreaCode}`,
            serviceDeliveryAreaCode,
            serviceDeliveryAreaName: namesByBoundaryAndCode.get(`SDA_${serviceDeliveryAreaCode}`),
            mcfdRegionCode,
            mcfdRegionName: namesByBoundaryAndCode.get(`MCFD_${mcfdRegionCode}`),
          },
        }
      })
      .sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }))
  })

  const ids = features.map((feature) => feature.id)
  if (features.length !== 47 || new Set(ids).size !== 47) {
    throw new Error(`Expected 47 unique dashboard LSA polygons; found ${features.length} features and ${new Set(ids).size} identifiers`)
  }
  for (const requiredId of ['LSA_2528', 'LSA_2529']) {
    if (!ids.includes(requiredId)) throw new Error(`Dashboard map did not contain ${requiredId}`)
  }
  if (features.some((feature) => !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type))) {
    throw new Error('Dashboard LSA capture contained a missing or non-polygon geometry')
  }
  const serviceDeliveryAreaCount = new Set(features.map((feature) => feature.properties.serviceDeliveryAreaCode)).size
  const mcfdRegionCount = new Set(features.map((feature) => feature.properties.mcfdRegionCode)).size
  if (serviceDeliveryAreaCount !== 13 || mcfdRegionCount !== 4) {
    throw new Error(`Expected dashboard hierarchy 4 Regions -> 13 SDAs -> 47 LSAs; found ${mcfdRegionCount} -> ${serviceDeliveryAreaCount} -> ${features.length}`)
  }

  const collection = {
    type: 'FeatureCollection',
    name: 'UBC EDI dashboard historical MCFD Local Service Areas',
    metadata: {
      sourceUrl: DASHBOARD_URL,
      sourceInterface: 'Shiny Leaflet runtime layer registry',
      captureCommand: 'npm run early-learning-boundaries:capture-dashboard-lsa',
      featureCount: features.length,
      redistributable: false,
      restriction: 'No dataset-specific open redistribution licence was found; retain in the ignored local cache pending written permission.',
      note: 'The live map contains 47 polygon layers, including LSA_2528 and LSA_2529. The dashboard search index exposes 46 LSAs and omits LSA_2529.',
    },
    features,
  }
  const payload = `${JSON.stringify(collection)}\n`
  const compressed = gzipDeterministic(payload)
  mkdirSync(CACHE_ROOT, { recursive: true })
  writeFileSync(OUTPUT_PATH, payload)
  writeFileSync(`${OUTPUT_PATH}.gz`, compressed)

  console.log(JSON.stringify({
    output: OUTPUT_PATH,
    featureCount: features.length,
    bytes: Buffer.byteLength(payload),
    gzipBytes: compressed.length,
    sha256: sha256(payload),
    hierarchy: {
      mcfdRegions: mcfdRegionCount,
      serviceDeliveryAreas: serviceDeliveryAreaCount,
      localServiceAreas: features.length,
    },
    includes: ['LSA_2528', 'LSA_2529'],
  }, null, 2))
} finally {
  await browser.close()
}
