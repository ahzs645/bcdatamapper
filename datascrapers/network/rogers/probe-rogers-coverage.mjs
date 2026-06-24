import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output')
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')
const CONFIG_PATH = path.join(OUTPUT_DIR, 'config.json')
const SAMPLE_TILE_PATH = path.join(OUTPUT_DIR, 'sample-tile.png')

const ROGERS_COVERAGE_URL = 'https://www.rogers.com/mobility/network-coverage-map'
const SPATIALBUZZ_CUSTOMER = '593E2268'
const SPATIALBUZZ_BOOTSTRAP_URL =
  'https://rog-ca.spatialbuzz.net/cust/593E2268/public/init/bootstrap-coverage-593E2268-272F320D-outer-init.js'

function parseArgs(argv) {
  const args = {
    headless: true,
    timeoutMs: 30_000,
    sampleTile: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--headless') args.headless = true
    else if (arg === '--headed') args.headless = false
    else if (arg === '--sample-tile') args.sampleTile = true
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i])
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1_000) {
    throw new Error('--timeout-ms must be >= 1000')
  }

  return args
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tileTemplateFromUrl(url) {
  const match = url.match(/^(.*\/styles\/[^/]+)\/(\d+)\/(\d+)\/(\d+)\.png(?:\?.*)?$/)
  if (!match) return null
  return `${match[1]}/{z}/{x}/{y}.png`
}

function layerSummary(layer) {
  return {
    layerId: layer.layer_id,
    style: layer.style,
    label: layer.layerName,
    mobileLabel: layer.layerNameMobile,
    opacity: layer.layerOpacity,
    zoomRangeFrom: layer.zoomRangeFrom,
    zoomRangeTo: layer.zoomRangeTo,
    tileUrl: layer.imageUriGoogle,
    legend: (layer.layerLegend ?? []).map((item) => ({
      label: item.l,
      color: item.c,
    })),
  }
}

async function fetchBytes(page, url) {
  const base64 = await page.evaluate(async (requestUrl) => {
    const response = await fetch(requestUrl)
    if (!response.ok) throw new Error(`${requestUrl} returned HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }, url)

  return Buffer.from(base64, 'base64')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  await mkdir(OUTPUT_DIR, { recursive: true })

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: args.headless,
  })

  const tileUrls = new Set()
  let capturedConfig = null
  let capturedConfigUrl = null

  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    })

    page.on('response', async (response) => {
      const url = response.url()
      if (url.includes('/api/maps/2010-11-22/config/customer/') && response.status() === 200) {
        try {
          capturedConfig = await response.json()
          capturedConfigUrl = url
        } catch {
          // Ignore parse failures; the caller will fail if no config is captured.
        }
      }

      if (/593e2268-tiles\.spatialbuzz\.net\/tiles\/.*\/styles\/.*\/\d+\/\d+\/\d+\.png/.test(url)) {
        tileUrls.add(url)
      }
    })

    await page.goto(ROGERS_COVERAGE_URL, { waitUntil: 'domcontentloaded', timeout: args.timeoutMs })

    const deadline = Date.now() + args.timeoutMs
    while ((!capturedConfig || tileUrls.size === 0) && Date.now() < deadline) {
      await sleep(250)
    }

    if (!capturedConfig) throw new Error('Rogers SpatialBuzz config was not captured')

    const layers = (capturedConfig.overlay_layers ?? []).map(layerSummary)
    const observedTileUrls = [...tileUrls].sort()
    const configuredTileTemplates = [...new Set(layers.map((layer) => layer.tileUrl).filter(Boolean))].sort()
    const observedTileTemplates = [...new Set(observedTileUrls.map(tileTemplateFromUrl).filter(Boolean))].sort()
    const manifest = {
      provider: 'Rogers',
      source: ROGERS_COVERAGE_URL,
      spatialBuzzCustomer: SPATIALBUZZ_CUSTOMER,
      spatialBuzzBootstrap: SPATIALBUZZ_BOOTSTRAP_URL,
      capturedAt: new Date().toISOString(),
      coverageUpdated: capturedConfig.init_params?.coverageUpdated ?? null,
      customerName: capturedConfig.init_params?.customer_name ?? null,
      configUrl: capturedConfigUrl,
      configuredTileTemplates,
      observedTileTemplates,
      observedTileUrls,
      layers,
    }

    await writeFile(CONFIG_PATH, `${JSON.stringify(capturedConfig, null, 2)}\n`)
    await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)

    if (args.sampleTile && observedTileUrls[0]) {
      await writeFile(SAMPLE_TILE_PATH, await fetchBytes(page, observedTileUrls[0]))
    }

    console.log(`Rogers coverage updated: ${manifest.coverageUpdated ?? 'unknown'}`)
    console.log(`Captured ${layers.length} overlay layers`)
    for (const layer of layers) {
      console.log(`${layer.layerId}\t${layer.style}\t${layer.label}`)
    }
    console.log(`Observed ${observedTileUrls.length} tile requests`)
    console.log(`Wrote ${path.relative(process.cwd(), MANIFEST_PATH)}`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
