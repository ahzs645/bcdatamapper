import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const OUTPUT_DIR = 'public/data/network-availability'
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')
const DEFAULT_TIMEOUT_MS = 20_000

const sources = [
  {
    id: 'crtc-5g-coverage',
    title: '5G Coverage',
    source: 'CRTC',
    category: 'coverage',
    geometry: 'polygon',
    formats: ['KML', 'MapInfo TAB'],
    url: 'https://web.crtc.gc.ca/cartovista/5GOverYearsYE2024_Src/5GOverYears_DL_V1.zip',
    notes: 'National vector polygons for 5G coverage by reporting year.',
  },
  {
    id: 'crtc-lte-coverage',
    title: 'LTE Coverage',
    source: 'CRTC',
    category: 'coverage',
    geometry: 'polygon',
    formats: ['KML', 'MapInfo TAB'],
    url: 'https://web.crtc.gc.ca/cartovista/LTEOverTheYearsYE2024_Src/LTEOverTheYears_DL_V1.zip',
    notes: 'National vector polygons for LTE coverage by reporting year.',
  },
  {
    id: 'crtc-lte-providers',
    title: 'LTE Providers',
    source: 'CRTC',
    category: 'provider-count',
    geometry: 'polygon',
    formats: ['KML', 'MapInfo TAB'],
    url: 'https://web.crtc.gc.ca/cartovista/LTEProviderCountYE2024_Src/LTEProviderCount_DL_V1.zip',
    notes: 'National vector polygons with LTE network/provider count. This does not identify individual provider names.',
  },
  {
    id: 'crtc-lte-road-coverage',
    title: 'LTE Road Coverage',
    source: 'CRTC',
    category: 'road-coverage',
    geometry: 'line',
    formats: ['KML', 'MapInfo TAB'],
    url: 'https://web.crtc.gc.ca/cartovista/RoadsWithAndWithoutLTE_src/LTERoadsYE2024.zip',
    notes: 'National vector road line coverage with LTE and non-LTE road classes.',
  },
  {
    id: 'crtc-mobile-broadband-availability-csv',
    title: 'Mobile and broadband availability tables',
    source: 'CRTC Open Data',
    category: 'availability-table',
    geometry: 'table',
    formats: ['CSV ZIP'],
    url: 'https://applications.crtc.gc.ca/OpenData/CASP/COMMUNICATION%20MONITORING%20REPORTS/Telecommunications%20Overview/English/data-mobile-and-broadband-availability.zip',
    notes: 'CRTC Communications Market Reports availability tables. Use as supporting tabular metadata, not map geometry.',
  },
  {
    id: 'nrcan-wireless-data-network-fgdb',
    title: 'Atlas of Canada Wireless Data Network',
    source: 'NRCan / Open Canada',
    category: 'coverage',
    geometry: 'polygon',
    formats: ['File Geodatabase'],
    url: 'https://ftp.maps.canada.ca/pub/nrcan_rncan/Geographical-maps_Carte-geographique/Wireless_Data_Network-Reseau_de_donnees_sans_fil/AtlasofCanada_Communications_AtlasduCanada.gdb.zip',
    apiUrl: 'https://maps-cartes.services.geo.ca/server_serveur/rest/services/NRCan/Wireless_Data_Network_Reseau_donnees_sans_fil/MapServer/0',
    expectedContentLength: 10_943_606,
    notes: 'Open Canada/NRCan hosted vector layer derived from CRTC wireless data network reporting.',
  },
  {
    id: 'ised-terrestrial-spectrum-sites',
    title: 'Terrestrial spectrum licence site data',
    source: 'ISED',
    category: 'cell-sites',
    geometry: 'point',
    formats: ['CSV ZIP'],
    url: 'https://www.ic.gc.ca/engineering/SMS_TAFL_Files/Site_Data_Extract_FX.zip',
    schemaUrl: 'https://ised-isde.canada.ca/site/spectrum-management-system/sites/default/files/documents/Field%20Descriptions%20-%20Descriptions%20des%20champs_0.pdf',
    notes: 'Licensed terrestrial radio/cell-site points with operator, technology, frequency, antenna, and WGS84 coordinates. This is infrastructure, not coverage polygons.',
  },
]

const carrierFindings = [
  {
    provider: 'TELUS',
    vectorStatus: 'public-vector-tiles',
    recommendedUse: 'Fetch Carto TileJSON/MVT tiles and convert to GeoJSON or PMTiles if provider-specific TELUS coverage is needed.',
    endpoints: [
      'https://www.telus.com/network/tools/coverage-map/api/brand-config/Telus',
      'https://www.telus.com/network/tools/coverage-map/api/carto/v3/maps/public-coverage-map/tileset',
    ],
  },
  {
    provider: 'Rogers',
    vectorStatus: 'raster-only-public-app',
    recommendedUse: 'Keep as carrier tile metadata or link to source. Raster polygonization would be approximate and source-term sensitive.',
    endpoints: ['https://593e2268-tiles.spatialbuzz.net/tiles/rog_ca-v200/styles/rog_ca_v200_comp/{z}/{x}/{y}.png'],
  },
  {
    provider: 'Bell',
    vectorStatus: 'raster-only-public-app',
    recommendedUse: 'Use CRTC/NRCan vector sources for national availability. Bell public map exposes Korem raster tiles and point lookup, not bulk vector coverage.',
    endpoints: ['https://bellmaps.korem.com/Coverage/getSiteConfig?siteId=Bell.ca&callback=callback'],
  },
  {
    provider: 'Videotron',
    vectorStatus: 'raster-only-public-app',
    recommendedUse: 'Use CRTC/NRCan vector sources for national availability. Public map coverage is CloudFront/OpenLayers PNG tiles.',
    endpoints: ['https://dnyepvvjamjdg.cloudfront.net/vl_carto_vcom/{z}/{x}/{y}.png'],
  },
  {
    provider: 'Freedom Mobile',
    vectorStatus: 'raster-only-public-app',
    recommendedUse: 'Use CRTC/NRCan vector sources for national availability. Public map coverage is CloudFront/OpenLayers PNG tiles.',
    endpoints: [
      'https://dnyepvvjamjdg.cloudfront.net/freelte1/{z}/{x}/{y}.png',
      'https://dnyepvvjamjdg.cloudfront.net/free3g/{z}/{x}/{y}.png',
    ],
  },
]

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'user-agent': 'PGMaps bcdatamapper network availability scraper',
        accept: '*/*',
        ...(options.headers ?? {}),
      },
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function probeSource(source) {
  try {
    const response = await fetchWithTimeout(source.url, { method: 'HEAD' })
    return {
      ...source,
      http: {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length') ? Number(response.headers.get('content-length')) : source.expectedContentLength ?? null,
        lastModified: response.headers.get('last-modified'),
        etag: response.headers.get('etag'),
      },
    }
  } catch (error) {
    return {
      ...source,
      http: {
        ok: false,
        status: null,
        contentLength: source.expectedContentLength ?? null,
        error: error.message,
      },
    }
  }
}

async function main() {
  const datasets = await Promise.all(sources.map(probeSource))
  const manifest = {
    generatedAt: new Date().toISOString(),
    title: 'Canada network availability vector sources',
    description:
      'Vector-first source inventory for Canadian mobile network availability. CRTC/NRCan sources provide national coverage geometry; ISED provides licensed site points; most carrier public maps expose raster tiles only.',
    coverage: 'Canada',
    license: 'CRTC/NRCan Open Canada sources use the Open Government Licence - Canada; carrier and ISED sources are source-dependent and require attribution/terms review before redistribution.',
    recommendedUse:
      'Use CRTC 5G/LTE/LTE-provider/road-coverage ZIPs or the NRCan FGDB/Esri service for app map availability. Use ISED site points as infrastructure context. Use carrier tile metadata only where a source is raster-only.',
    datasets,
    carrierFindings,
  }

  await mkdir(OUTPUT_DIR, { recursive: true })
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`network-availability: wrote ${datasets.length} sources to ${MANIFEST_PATH}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
