import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const OUTPUT_DIR = 'public/data/cell-coverage'
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')
const DEFAULT_TIMEOUT_MS = 20_000

const CANADA_BOUNDS = [-141.01, 41.68, -52.62, 83.14]

const providers = [
  {
    id: 'rogers',
    name: 'Rogers',
    sourceUrl: 'https://www.rogers.com/mobility/network-coverage-map',
    platform: 'spatialbuzz-raster',
    attribution: 'Rogers / Spatialbuzz',
    notes: 'Raster coverage tiles discovered from the Rogers Spatialbuzz iframe.',
    layers: [
      {
        id: 'rogers-combined',
        label: 'Rogers combined coverage',
        technology: 'combined',
        format: 'png',
        minzoom: 0,
        maxzoom: 12,
        opacity: 0.7,
        tileUrl: 'https://593e2268-tiles.spatialbuzz.net/tiles/rog_ca-v200/styles/rog_ca_v200_comp/{z}/{x}/{y}.png',
        sampleTile: 'https://593e2268-tiles.spatialbuzz.net/tiles/rog_ca-v200/styles/rog_ca_v200_comp/4/4/5.png',
      },
    ],
  },
  {
    id: 'telus',
    name: 'TELUS',
    sourceUrl: 'https://www.telus.com/en/mobility/network/coverage-map',
    configUrl: 'https://www.telus.com/network/tools/coverage-map/api/brand-config/Telus',
    platform: 'carto-vector',
    attribution: 'TELUS / CARTO',
    notes: 'Vector tilejson URLs are read from the public TELUS coverage-map brand config.',
    layerOrder: ['5g-3500', '5g', 'lte-advanced', 'lte', 'hspa', 'lte-m'],
    layerLabels: {
      '5g-3500': '5G 3500 MHz',
      '5g': '5G',
      'lte-advanced': 'LTE Advanced',
      lte: 'LTE',
      hspa: 'HSPA',
      'lte-m': 'LTE-M / LPWA',
    },
  },
  {
    id: 'bell',
    name: 'Bell',
    sourceUrl: 'https://www.bell.ca/Mobility/Our_network_coverage',
    configUrl: 'https://bellmaps.korem.com/Coverage/getSiteConfig?siteId=Bell-brf.ca&callback=callback',
    platform: 'korem-raster',
    attribution: 'Bell / Korem',
    notes: 'Korem coverage tiles use one-based Google tile coordinates and z+1 in the request.',
    layers: [
      {
        id: 'bell-5g-lte',
        label: 'Bell 5G/LTE coverage',
        technology: '5g-lte',
        format: 'png',
        minzoom: 4,
        maxzoom: 12,
        opacity: 0.7,
        tileUrl:
          'https://bellmaps.korem.com/TMS/getTile?workspace=Bell.ca&layers=5G_PLUS_Advanced,5G_PLUS,5G,LTE_Advanced,LTE&z={zPlusOne}&x={xPlusOne}&y={yPlusOne}&timestamp={timestamp}',
      },
      {
        id: 'bell-hspa',
        label: 'Bell HSPA coverage',
        technology: 'hspa',
        format: 'png',
        minzoom: 4,
        maxzoom: 12,
        opacity: 0.7,
        tileUrl:
          'https://bellmaps.korem.com/TMS/getTile?workspace=Bell.ca&layers=HSPA&z={zPlusOne}&x={xPlusOne}&y={yPlusOne}&timestamp={timestamp}',
      },
      {
        id: 'bell-lte-m',
        label: 'Bell LTE-M coverage',
        technology: 'lte-m',
        format: 'png',
        minzoom: 4,
        maxzoom: 12,
        opacity: 0.7,
        tileUrl:
          'https://bellmaps.korem.com/TMS/getTile?workspace=Bell.ca&layers=LTE_M&z={zPlusOne}&x={xPlusOne}&y={yPlusOne}&timestamp={timestamp}',
      },
    ],
  },
  {
    id: 'videotron',
    name: 'Videotron',
    sourceUrl: 'https://www.videotron.com/en/mobile/mobile-network-coverage',
    platform: 'openlayers-raster',
    attribution: 'Videotron',
    notes: 'Videotron coverage is served from the shared Videotron CloudFront OpenLayers app.',
    layers: [
      {
        id: 'videotron-lte',
        label: 'Videotron LTE coverage',
        technology: 'lte',
        format: 'png',
        minzoom: 0,
        maxzoom: 15,
        opacity: 1,
        tileUrl: 'https://dnyepvvjamjdg.cloudfront.net/vl_carto_vcom/{z}/{x}/{y}.png',
        sampleTile: 'https://dnyepvvjamjdg.cloudfront.net/vl_carto_vcom/4/4/5.png',
      },
    ],
  },
  {
    id: 'freedom',
    name: 'Freedom Mobile',
    sourceUrl: 'https://www.freedommobile.ca/en-CA/network-coverage',
    platform: 'openlayers-raster',
    attribution: 'Freedom Mobile / Videotron',
    notes: 'Freedom embeds the Videotron CloudFront OpenLayers coverage app.',
    layers: [
      {
        id: 'freedom-nationwide',
        label: 'Freedom nationwide coverage',
        technology: 'nationwide',
        format: 'png',
        minzoom: 0,
        maxzoom: 15,
        opacity: 1,
        tileUrl: 'https://dnyepvvjamjdg.cloudfront.net/free3g/{z}/{x}/{y}.png',
        sampleTile: 'https://dnyepvvjamjdg.cloudfront.net/free3g/4/4/5.png',
      },
      {
        id: 'freedom-extended-lte',
        label: 'Freedom extended LTE coverage',
        technology: 'extended-lte',
        format: 'png',
        minzoom: 0,
        maxzoom: 15,
        opacity: 1,
        tileUrl: 'https://dnyepvvjamjdg.cloudfront.net/freelte1/{z}/{x}/{y}.png',
        sampleTile: 'https://dnyepvvjamjdg.cloudfront.net/freelte1/4/4/5.png',
      },
    ],
  },
]

async function fetchJson(url) {
  const response = await fetchWithTimeout(url)
  const text = await response.text()
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  const trimmed = text.trim()
  const jsonpMatch = trimmed.match(/^[A-Za-z_$][\w$]*\(([\s\S]*)\);?$/)
  return JSON.parse(jsonpMatch ? jsonpMatch[1] : trimmed)
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'user-agent': 'PGMaps bcdatamapper cell coverage scraper',
        accept: 'application/json,image/png,*/*',
        ...(options.headers ?? {}),
      },
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function buildTelusProvider(provider) {
  const config = await fetchJson(provider.configUrl)
  const layers = []
  for (const key of provider.layerOrder) {
    const tileset = config.cartoTilesets?.[key]
    if (!tileset) continue
    const tilejsonUrl = new URL(
      'https://www.telus.com/network/tools/coverage-map/api/carto/v3/maps/public-coverage-map/tileset',
    )
    tilejsonUrl.searchParams.set('format', 'tilejson')
    tilejsonUrl.searchParams.set('name', tileset)
    tilejsonUrl.searchParams.set('v', '3.4')
    tilejsonUrl.searchParams.set('client', 'deck-gl-carto')
    tilejsonUrl.searchParams.set('deckglVersion', '9.1.2')
    const tilejson = await fetchJson(tilejsonUrl)
    layers.push({
      id: `telus-${key}`,
      label: provider.layerLabels[key] ?? key,
      technology: key,
      format: 'mvt',
      minzoom: tilejson.minzoom,
      maxzoom: tilejson.maxzoom,
      opacity: config.coverageOpacity ?? 0.7,
      bounds: tilejson.bounds,
      center: tilejson.center,
      tilejsonUrl: tilejsonUrl.toString(),
      tileUrl: tilejson.tiles?.[0],
      vectorLayers: tilejson.vector_layers ?? [],
      tilestats: tilejson.tilestats ?? null,
    })
  }
  return {
    ...pickProviderFields(provider),
    bounds: normalizeBounds(config.bounds),
    center: normalizeCenter(config.center),
    layers,
  }
}

async function buildBellProvider(provider) {
  const config = await fetchJson(provider.configUrl)
  const timestamp = config.timestamp
  const layers = provider.layers.map((layer) => ({
    ...layer,
    bounds: normalizeBounds(config.bounds),
    tileUrl: layer.tileUrl.replace('{timestamp}', timestamp),
    coordinateTemplate: {
      z: 'z+1',
      x: 'x+1',
      y: 'y+1',
    },
  }))
  return {
    ...pickProviderFields(provider),
    bounds: normalizeBounds(config.bounds),
    center: normalizeCenter(config.center),
    timestamp,
    layers,
  }
}

async function buildStaticProvider(provider) {
  const checks = await Promise.all(
    provider.layers.map(async (layer) => ({
      layerId: layer.id,
      sampleTile: layer.sampleTile ?? null,
      status: layer.sampleTile ? await probe(layer.sampleTile) : { ok: null, status: null, contentType: null },
    })),
  )
  return {
    ...pickProviderFields(provider),
    bounds: CANADA_BOUNDS,
    layers: provider.layers,
    checks,
  }
}

async function probe(url) {
  try {
    const response = await fetchWithTimeout(url, { method: 'HEAD' })
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length'),
      lastModified: response.headers.get('last-modified'),
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      contentType: null,
      error: error.message,
    }
  }
}

function pickProviderFields(provider) {
  return {
    id: provider.id,
    name: provider.name,
    sourceUrl: provider.sourceUrl,
    configUrl: provider.configUrl,
    platform: provider.platform,
    attribution: provider.attribution,
    notes: provider.notes,
  }
}

function normalizeBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return CANADA_BOUNDS
  const values = bounds.map(Number)
  if (values.some((value) => !Number.isFinite(value))) return CANADA_BOUNDS
  const [north, east, south, west] = values
  if (north > south && east > west) return [west, south, east, north]
  return values
}

function normalizeCenter(center) {
  if (!Array.isArray(center) || center.length < 2) return [-95, 55.77]
  const lat = Number(center[0])
  const lon = Number(center[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [-95, 55.77]
  return [lon, lat]
}

async function main() {
  const syncedProviders = []
  const failures = []

  for (const provider of providers) {
    try {
      if (provider.id === 'telus') {
        syncedProviders.push(await buildTelusProvider(provider))
      } else if (provider.id === 'bell') {
        syncedProviders.push(await buildBellProvider(provider))
      } else {
        syncedProviders.push(await buildStaticProvider(provider))
      }
    } catch (error) {
      failures.push({ provider: provider.id, message: error.message })
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    title: 'Canada cell coverage map tile sources',
    description:
      'Normalized carrier coverage tile metadata for Rogers, TELUS, Bell, Videotron, and Freedom Mobile. Coverage is provider-reported and approximate.',
    coverage: 'Canada',
    bounds: CANADA_BOUNDS,
    license: 'Source-dependent carrier map terms; do not redistribute tiles as bulk data without reviewing provider terms.',
    providers: syncedProviders,
    failures,
  }

  await mkdir(OUTPUT_DIR, { recursive: true })
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`cell-coverage: wrote ${syncedProviders.length} providers to ${MANIFEST_PATH}`)
  if (failures.length) {
    console.warn(`cell-coverage: ${failures.length} provider(s) failed`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
