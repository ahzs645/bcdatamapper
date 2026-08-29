import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { union } from '@turf/turf'
import { chromium } from 'playwright'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const CACHE_ROOT = join(SCRIPT_DIR, 'cache')
const OUTPUT_PATH = join(CACHE_ROOT, 'dashboard_mcfd_local_service_areas.geojson')
const SDA_OUTPUT_PATH = join(CACHE_ROOT, 'dashboard_mcfd_service_delivery_areas.geojson')
const REGION_OUTPUT_PATH = join(CACHE_ROOT, 'dashboard_mcfd_regions.geojson')
const INDEX_OUTPUT_PATH = join(CACHE_ROOT, 'dashboard_mcfd_boundary_index.json')
const DASHBOARD_URL = 'https://dashboard.earlylearning.ubc.ca/'
const DASHBOARD_STATE_URL = `${DASHBOARD_URL}?_inputs_&boundarySelector=%22LSA%22&regionSelector=%22LSA_2528%22&caseSelector=%22LSA_2528_9%22&scalesScaleSelector=%22overall%22&introjs-dontShowAgain=true`

function sha256(payload) {
  return createHash('sha256').update(payload).digest('hex')
}

function gzipDeterministic(payload) {
  return gzipSync(payload, { level: 9, mtime: 0 })
}

function writeJsonAndGzip(path, value) {
  const payload = `${JSON.stringify(value)}\n`
  const compressed = gzipDeterministic(payload)
  writeFileSync(path, payload)
  writeFileSync(`${path}.gz`, compressed)
  return {
    path,
    bytes: Buffer.byteLength(payload),
    gzipBytes: compressed.length,
    sha256: sha256(payload),
  }
}

function dissolveBy(features, property, createProperties) {
  const grouped = new Map()
  for (const feature of features) {
    const code = String(feature.properties[property] ?? '').trim()
    if (!code) throw new Error(`Dashboard feature was missing ${property}`)
    grouped.set(code, [...(grouped.get(code) ?? []), feature])
  }

  return [...grouped.entries()]
    .map(([code, groupedFeatures]) => {
      const dissolved = groupedFeatures.slice(1).reduce(
        (merged, feature) => union(merged, feature),
        groupedFeatures[0],
      )
      if (!dissolved?.geometry || !['Polygon', 'MultiPolygon'].includes(dissolved.geometry.type)) {
        throw new Error(`Could not dissolve dashboard features for ${property}=${code}`)
      }
      const properties = createProperties(code, groupedFeatures[0].properties)
      return {
        type: 'Feature',
        id: properties.regionId,
        properties,
        geometry: dissolved.geometry,
      }
    })
    .sort((left, right) => left.properties.regionCode.localeCompare(
      right.properties.regionCode,
      'en',
      { numeric: true },
    ))
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
            parentBoundaryCode: 'SDA',
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

  const serviceDeliveryAreaFeatures = dissolveBy(
    features,
    'serviceDeliveryAreaCode',
    (code, properties) => ({
      boundaryCode: 'SDA',
      boundaryName: 'MCFD Service Delivery Area',
      regionId: `SDA_${code}`,
      regionCode: code,
      regionName: properties.serviceDeliveryAreaName,
      parentBoundaryCode: 'MCFD',
      parentRegionId: `MCFD_${properties.mcfdRegionCode}`,
      mcfdRegionCode: properties.mcfdRegionCode,
      mcfdRegionName: properties.mcfdRegionName,
      derivedFrom: 'Dashboard LSA dissolve on serviceDeliveryAreaCode',
    }),
  )
  const regionFeatures = dissolveBy(
    serviceDeliveryAreaFeatures,
    'mcfdRegionCode',
    (code, properties) => ({
      boundaryCode: 'MCFD',
      boundaryName: 'MCFD Region',
      regionId: `MCFD_${code}`,
      regionCode: code,
      regionName: properties.mcfdRegionName,
      derivedFrom: 'Dashboard SDA dissolve on mcfdRegionCode',
    }),
  )
  if (serviceDeliveryAreaFeatures.length !== 13 || regionFeatures.length !== 4) {
    throw new Error(`Dissolved dashboard hierarchy had unexpected counts: ${regionFeatures.length} -> ${serviceDeliveryAreaFeatures.length} -> ${features.length}`)
  }

  const sharedMetadata = {
    sourceUrl: DASHBOARD_URL,
    sourceInterface: 'Shiny Leaflet runtime layer registry',
    sourceVintage: 'Historical 4 Region / 13 SDA / 47 LSA dashboard geography',
    captureCommand: 'npm run early-learning-boundaries:capture-dashboard-lsa',
    redistributable: false,
    restriction: 'No dataset-specific open redistribution licence was found; retain in the ignored local cache pending written permission.',
  }
  const collection = {
    type: 'FeatureCollection',
    name: 'UBC EDI dashboard historical MCFD Local Service Areas',
    metadata: {
      ...sharedMetadata,
      featureCount: features.length,
      note: 'The live map contains 47 polygon layers, including LSA_2528 and LSA_2529. The dashboard search index exposes 46 LSAs and omits LSA_2529.',
    },
    features,
  }
  const serviceDeliveryAreaCollection = {
    type: 'FeatureCollection',
    name: 'UBC EDI dashboard historical MCFD Service Delivery Areas',
    metadata: {
      ...sharedMetadata,
      featureCount: serviceDeliveryAreaFeatures.length,
      derivedFrom: '47 dashboard LSA polygons dissolved by serviceDeliveryAreaCode',
    },
    features: serviceDeliveryAreaFeatures,
  }
  const regionCollection = {
    type: 'FeatureCollection',
    name: 'UBC EDI dashboard historical MCFD Regions',
    metadata: {
      ...sharedMetadata,
      featureCount: regionFeatures.length,
      derivedFrom: '13 dashboard SDA polygons dissolved by mcfdRegionCode',
    },
    features: regionFeatures,
  }
  const boundaryIndex = {
    name: 'UBC EDI dashboard historical MCFD boundary index',
    ...sharedMetadata,
    hierarchy: ['MCFD', 'SDA', 'LSA'],
    levels: {
      MCFD: {
        featureCount: regionFeatures.length,
        file: 'dashboard_mcfd_regions.geojson',
        codeProperty: 'regionCode',
        nameProperty: 'regionName',
      },
      SDA: {
        featureCount: serviceDeliveryAreaFeatures.length,
        file: 'dashboard_mcfd_service_delivery_areas.geojson',
        codeProperty: 'regionCode',
        nameProperty: 'regionName',
        parentCodeProperty: 'mcfdRegionCode',
      },
      LSA: {
        featureCount: features.length,
        file: 'dashboard_mcfd_local_service_areas.geojson',
        codeProperty: 'regionCode',
        nameProperty: 'regionName',
        parentCodeProperty: 'serviceDeliveryAreaCode',
      },
    },
  }
  mkdirSync(CACHE_ROOT, { recursive: true })
  const outputs = {
    regions: writeJsonAndGzip(REGION_OUTPUT_PATH, regionCollection),
    serviceDeliveryAreas: writeJsonAndGzip(SDA_OUTPUT_PATH, serviceDeliveryAreaCollection),
    localServiceAreas: writeJsonAndGzip(OUTPUT_PATH, collection),
  }
  writeFileSync(INDEX_OUTPUT_PATH, `${JSON.stringify(boundaryIndex, null, 2)}\n`)

  console.log(JSON.stringify({
    output: CACHE_ROOT,
    outputs,
    index: INDEX_OUTPUT_PATH,
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
