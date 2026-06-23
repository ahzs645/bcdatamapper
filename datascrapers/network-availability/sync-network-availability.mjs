import { mkdir, writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import shp from 'shpjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output')
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')
const DEFAULT_TIMEOUT_MS = 45_000

const CRTC_PAGE_URL = 'https://crtc.gc.ca/eng/television/services/geo.htm'
const CRTC_CARTOVISTA_APP_URL = 'https://crtc.gc.ca/cartovista/Alert_En/'
const CRTC_CARTOVISTA_CONFIG_URL = 'https://crtc.gc.ca/cartovista/Alert_En/map/NPAS_2022BY_Config.xml'
const CRTC_CARTOVISTA_MAP_BASE = 'https://crtc.gc.ca/cartovista/Alert_En/map/'
const CRTC_SHAPE_ZIP_URL = 'https://crtc.gc.ca/cartovista/Alert_Src/Shape_En.zip'

const crtcDownloadSources = [
  {
    id: 'crtc-npas-cartovista-shapefile',
    title: 'CRTC NPAS map shapefile bundle',
    source: 'CRTC',
    category: 'source-bundle',
    geometry: 'mixed',
    formats: ['Shapefile ZIP'],
    url: CRTC_SHAPE_ZIP_URL,
    notes:
      'Official downloadable GIS package for the CRTC NPAS map. Includes current 5G Coverage, LTE Coverage, road coverage, broadcast contours, and station/service-provider points.',
  },
  {
    id: 'crtc-npas-cartovista-kml',
    title: 'CRTC NPAS map KML bundle',
    source: 'CRTC',
    category: 'source-bundle',
    geometry: 'mixed',
    formats: ['KML ZIP'],
    url: 'https://crtc.gc.ca/cartovista/Alert_Src/Kml_En.zip',
    notes: 'Official KML package for the CRTC NPAS map.',
  },
  {
    id: 'crtc-npas-cartovista-tab',
    title: 'CRTC NPAS map MapInfo TAB bundle',
    source: 'CRTC',
    category: 'source-bundle',
    geometry: 'mixed',
    formats: ['MapInfo TAB ZIP'],
    url: 'https://crtc.gc.ca/cartovista/Alert_Src/Tab_En.zip',
    notes: 'Official MapInfo TAB package for the CRTC NPAS map.',
  },
  {
    id: 'crtc-5g-over-years-2024',
    title: '5G coverage over years to 2024',
    source: 'CRTC',
    category: 'historical-coverage',
    geometry: 'polygon',
    formats: ['KML ZIP', 'MapInfo TAB ZIP'],
    url: 'https://web.crtc.gc.ca/cartovista/5GOverYearsYE2024_Src/5GOverYears_DL_V1.zip',
    years: [2020, 2021, 2022, 2023, 2024],
    notes:
      'Historical CRTC 5G coverage package discovered from the CRTC CartoVista source inventory. Contains KML and MapInfo files for 2020-2024.',
  },
  {
    id: 'crtc-lte-over-years-2024',
    title: 'LTE coverage over years to 2024',
    source: 'CRTC',
    category: 'historical-coverage',
    geometry: 'polygon',
    formats: ['KML ZIP', 'MapInfo TAB ZIP'],
    url: 'https://web.crtc.gc.ca/cartovista/LTEOverTheYearsYE2024_Src/LTEOverTheYears_DL_V1.zip',
    years: [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024],
    notes:
      'Historical CRTC LTE coverage package discovered from the CRTC CartoVista source inventory. Contains KML and MapInfo files for 2013-2024.',
  },
  {
    id: 'crtc-lte-providers-2024',
    title: 'LTE provider-count coverage to 2024',
    source: 'CRTC',
    category: 'provider-count',
    geometry: 'polygon',
    formats: ['KML ZIP', 'MapInfo TAB ZIP'],
    url: 'https://web.crtc.gc.ca/cartovista/LTEProviderCountYE2024_Src/LTEProviderCount_DL_V1.zip',
    notes: 'National vector polygons with LTE network/provider count. This does not identify individual provider names.',
  },
  {
    id: 'crtc-lte-road-coverage-2024',
    title: 'LTE road coverage to 2024',
    source: 'CRTC',
    category: 'road-coverage',
    geometry: 'line',
    formats: ['KML ZIP', 'MapInfo TAB ZIP'],
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
    notes:
      'Open Canada/NRCan hosted layer derived from CRTC wireless data reporting. This is grid/cell-like and less suitable than the dissolved CRTC NPAS LTE/5G layers for the PGMaps coverage overlay.',
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
    notes:
      'Licensed terrestrial radio/cell-site points with operator, technology, frequency, antenna, and WGS84 coordinates. This is infrastructure, not coverage polygons.',
  },
]

const cartovistaLayers = [
  {
    id: 'crtc-5g-coverage-current',
    title: '5G coverage',
    technology: '5G',
    category: 'coverage',
    fileName: '_5G_YE2024.json',
    shapefileName: '5G Coverage',
    outputName: 'crtc-5g-coverage-current.geojson.gz',
    year: 2024,
  },
  {
    id: 'crtc-lte-coverage-current',
    title: 'LTE coverage',
    technology: 'LTE',
    category: 'coverage',
    fileName: 'LTE_YE2024.json',
    shapefileName: 'LTE Coverage',
    outputName: 'crtc-lte-coverage-current.geojson.gz',
    year: 2024,
  },
  {
    id: 'crtc-major-roads-with-lte-5g',
    title: 'Major roads with LTE or 5G',
    technology: 'LTE/5G',
    category: 'road-coverage',
    fileName: 'LTE_Roads_comp_rev_02.json',
    shapefileName: 'Major roads with LTE or 5G',
    outputName: 'crtc-major-roads-with-lte-5g.geojson.gz',
    year: 2024,
  },
  {
    id: 'crtc-major-roads-without-lte-5g',
    title: 'Major roads without LTE and 5G',
    technology: 'No LTE/5G',
    category: 'road-coverage',
    fileName: 'Non_LTE_Roads_comp_rev_01.json',
    shapefileName: 'Major roads without LTE and 5G',
    outputName: 'crtc-major-roads-without-lte-5g.geojson.gz',
    year: 2024,
  },
  {
    id: 'crtc-broadcasting-distribution-undertakings',
    title: 'Broadcasting distribution undertakings',
    category: 'broadcast-provider',
    fileName: 'BroadcastingDistributionUndertakings_2.json',
    shapefileName: 'Broadcasting Distribution Undertakings',
    outputName: 'crtc-broadcasting-distribution-undertakings.geojson.gz',
  },
  {
    id: 'crtc-dtv-contours',
    title: 'DTV contours',
    category: 'broadcast-contour',
    fileName: 'DTVContours.json',
    shapefileName: 'DTV Contours',
    outputName: 'crtc-dtv-contours.geojson.gz',
  },
  {
    id: 'crtc-tv-contours',
    title: 'TV contours',
    category: 'broadcast-contour',
    fileName: 'TVContours.json',
    shapefileName: 'TV Contours',
    outputName: 'crtc-tv-contours.geojson.gz',
  },
  {
    id: 'crtc-fm-contours',
    title: 'FM contours',
    category: 'broadcast-contour',
    fileName: 'FMContours_3.json',
    shapefileName: 'FM Contours',
    outputName: 'crtc-fm-contours.geojson.gz',
  },
  {
    id: 'crtc-am-contours-night',
    title: 'AM contours night',
    category: 'broadcast-contour',
    fileName: 'AMContoursNight.json',
    shapefileName: 'AM Contours (Night)',
    outputName: 'crtc-am-contours-night.geojson.gz',
  },
  {
    id: 'crtc-am-contours-day',
    title: 'AM contours day',
    category: 'broadcast-contour',
    fileName: 'AMContoursDay.json',
    shapefileName: 'AM Contours (Day)',
    outputName: 'crtc-am-contours-day.geojson.gz',
  },
  {
    id: 'crtc-dtv-stations',
    title: 'DTV stations',
    category: 'broadcast-station',
    fileName: 'DTVStations.json',
    shapefileName: 'DTV Stations',
    outputName: 'crtc-dtv-stations.geojson.gz',
  },
  {
    id: 'crtc-tv-stations',
    title: 'TV stations',
    category: 'broadcast-station',
    fileName: 'TVStations.json',
    shapefileName: 'TV Stations',
    outputName: 'crtc-tv-stations.geojson.gz',
  },
  {
    id: 'crtc-fm-radio-stations',
    title: 'FM radio stations',
    category: 'broadcast-station',
    fileName: 'FMRadioStations_2.json',
    shapefileName: 'FM Radio Stations',
    outputName: 'crtc-fm-radio-stations.geojson.gz',
  },
  {
    id: 'crtc-am-radio-stations',
    title: 'AM radio stations',
    category: 'broadcast-station',
    fileName: 'AMRadioStations_2_1.json',
    shapefileName: 'AM Radio Stations',
    outputName: 'crtc-am-radio-stations.geojson.gz',
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
    recommendedUse:
      'Use CRTC/NRCan vector sources for national availability. Bell public map exposes Korem raster tiles and point lookup, not bulk vector coverage.',
    endpoints: ['https://bellmaps.korem.com/Coverage/getSiteConfig?siteId=Bell.ca&callback=callback'],
  },
  {
    provider: 'Videotron',
    vectorStatus: 'raster-only-public-app',
    recommendedUse:
      'Use CRTC/NRCan vector sources for national availability. Public map coverage is CloudFront/OpenLayers PNG tiles.',
    endpoints: ['https://dnyepvvjamjdg.cloudfront.net/vl_carto_vcom/{z}/{x}/{y}.png'],
  },
  {
    provider: 'Freedom Mobile',
    vectorStatus: 'raster-only-public-app',
    recommendedUse:
      'Use CRTC/NRCan vector sources for national availability. Public map coverage is CloudFront/OpenLayers PNG tiles.',
    endpoints: [
      'https://dnyepvvjamjdg.cloudfront.net/freelte1/{z}/{x}/{y}.png',
      'https://dnyepvvjamjdg.cloudfront.net/free3g/{z}/{x}/{y}.png',
    ],
  },
]

function prettyBytes(bytes) {
  if (!Number.isFinite(bytes)) return null
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}

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

async function fetchBytes(url) {
  const response = await fetchWithTimeout(url)
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    http: httpSummary(response),
  }
}

function httpSummary(response, fallbackLength = null) {
  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get('content-type'),
    contentLength: response.headers.get('content-length') ? Number(response.headers.get('content-length')) : fallbackLength,
    lastModified: response.headers.get('last-modified'),
    etag: response.headers.get('etag'),
    corsAllowOrigin: response.headers.get('access-control-allow-origin'),
  }
}

async function probeSource(source) {
  try {
    const response = await fetchWithTimeout(source.url, { method: 'HEAD' })
    return {
      ...source,
      http: httpSummary(response, source.expectedContentLength ?? null),
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

function createLccInverse() {
  const a = 6378137
  const f = 1 / 298.257222101
  const e = Math.sqrt(2 * f - f * f)
  const phi1 = 49 * Math.PI / 180
  const phi2 = 77 * Math.PI / 180
  const phi0 = 49 * Math.PI / 180
  const lambda0 = -95 * Math.PI / 180

  const m = (phi) => Math.cos(phi) / Math.sqrt(1 - e * e * Math.sin(phi) ** 2)
  const t = (phi) =>
    Math.tan(Math.PI / 4 - phi / 2) / (((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2))
  const n = (Math.log(m(phi1)) - Math.log(m(phi2))) / (Math.log(t(phi1)) - Math.log(t(phi2)))
  const fFactor = m(phi1) / (n * t(phi1) ** n)
  const rho0 = a * fFactor * t(phi0) ** n

  return (x, y) => {
    const rho = Math.sign(n) * Math.sqrt(x * x + (rho0 - y) * (rho0 - y))
    const theta = Math.atan2(x, rho0 - y)
    const tValue = (rho / (a * fFactor)) ** (1 / n)
    let phi = Math.PI / 2 - 2 * Math.atan(tValue)
    for (let i = 0; i < 8; i += 1) {
      phi = Math.PI / 2 - 2 * Math.atan(tValue * (((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2)))
    }
    const lambda = lambda0 + theta / n
    return [roundCoordinate(lambda * 180 / Math.PI), roundCoordinate(phi * 180 / Math.PI)]
  }
}

const lccToLonLat = createLccInverse()

function roundCoordinate(value) {
  return Math.round(value * 1e6) / 1e6
}

function decodeDeltaPairs(values) {
  const points = []
  let x = 0
  let y = 0
  for (let i = 0; i < values.length; i += 2) {
    if (i === 0) {
      x = values[i]
      y = values[i + 1]
    } else {
      x += values[i]
      y += values[i + 1]
    }
    points.push([x, y])
  }
  return points
}

function ringArea(points) {
  let area = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    area += points[j][0] * points[i][1] - points[i][0] * points[j][1]
  }
  return area / 2
}

function bboxForPoints(points) {
  const bbox = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of points) {
    bbox[0] = Math.min(bbox[0], x)
    bbox[1] = Math.min(bbox[1], y)
    bbox[2] = Math.max(bbox[2], x)
    bbox[3] = Math.max(bbox[3], y)
  }
  return bbox
}

function bboxContains(bbox, point) {
  return point[0] >= bbox[0] && point[0] <= bbox[2] && point[1] >= bbox[1] && point[1] <= bbox[3]
}

function pointInRing(point, ring) {
  let inside = false
  const [x, y] = point
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

function closeLonLatRing(ring) {
  if (ring.length === 0) return ring
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (first[0] === last[0] && first[1] === last[1]) return ring
  return [...ring, first]
}

function decodePolygonGeometry(rings) {
  const decoded = rings
    .map((ring, index) => {
      const xy = decodeDeltaPairs(ring)
      return {
        index,
        xy,
        lonLat: closeLonLatRing(xy.map(([x, y]) => lccToLonLat(x, y))),
        area: Math.abs(ringArea(xy)),
        bbox: bboxForPoints(xy),
        point: xy[0],
        parent: -1,
        depth: 0,
      }
    })
    .filter((ring) => ring.xy.length >= 4 && ring.area > 0)

  for (const ring of decoded) {
    let parent = null
    for (const candidate of decoded) {
      if (candidate.index === ring.index || candidate.area <= ring.area) continue
      if (!bboxContains(candidate.bbox, ring.point)) continue
      if (!pointInRing(ring.point, candidate.xy)) continue
      if (!parent || candidate.area < parent.area) parent = candidate
    }
    ring.parent = parent?.index ?? -1
  }

  const byIndex = new Map(decoded.map((ring) => [ring.index, ring]))
  function depthOf(ring) {
    if (ring.parent === -1) return 0
    const parent = byIndex.get(ring.parent)
    return parent ? depthOf(parent) + 1 : 0
  }
  for (const ring of decoded) ring.depth = depthOf(ring)

  const polygons = []
  const outerByIndex = new Map()
  for (const ring of decoded) {
    if (ring.depth % 2 !== 0) continue
    const polygon = [ring.lonLat]
    outerByIndex.set(ring.index, polygon)
    polygons.push(polygon)
  }

  for (const ring of decoded) {
    if (ring.depth % 2 === 0) continue
    const parent = outerByIndex.get(ring.parent)
    if (parent) parent.push(ring.lonLat)
  }

  if (polygons.length === 1) return { type: 'Polygon', coordinates: polygons[0] }
  return { type: 'MultiPolygon', coordinates: polygons }
}

function decodeLineGeometry(parts) {
  const lines = parts
    .map((part) => decodeDeltaPairs(part).map(([x, y]) => lccToLonLat(x, y)))
    .filter((line) => line.length >= 2)
  if (lines.length === 1) return { type: 'LineString', coordinates: lines[0] }
  return { type: 'MultiLineString', coordinates: lines }
}

function decodeCartoVistaGeometry(geometry) {
  if (geometry.t === 'Point') {
    return {
      type: 'Point',
      coordinates: lccToLonLat(geometry.c[0], geometry.c[1]),
    }
  }
  if (geometry.t === 'LineString') return decodeLineGeometry(geometry.c)
  if (geometry.t === 'Polygon') return decodePolygonGeometry(geometry.c)
  throw new Error(`Unsupported CartoVista geometry type: ${geometry.t}`)
}

function boundsForGeometry(geometry, bbox = [Infinity, Infinity, -Infinity, -Infinity]) {
  const visit = (coordinates) => {
    if (typeof coordinates[0] === 'number') {
      bbox[0] = Math.min(bbox[0], coordinates[0])
      bbox[1] = Math.min(bbox[1], coordinates[1])
      bbox[2] = Math.max(bbox[2], coordinates[0])
      bbox[3] = Math.max(bbox[3], coordinates[1])
      return
    }
    for (const child of coordinates) visit(child)
  }
  visit(geometry.coordinates)
  return bbox
}

function propertiesForFeature(layer, cartoJson, feature, index) {
  const properties = {
    id: feature.p?.[0] ?? String(index + 1),
    source: 'CRTC',
    sourceLayer: layer.id,
    sourceFile: layer.fileName,
    title: layer.title,
    category: layer.category,
  }
  if (layer.technology) properties.technology = layer.technology
  if (layer.year) properties.year = layer.year

  for (const [attributeIndex, definition] of (cartoJson.attributeDefinitions ?? []).entries()) {
    const name = definition[0]
    if (properties[name] == null && feature.p?.[attributeIndex] != null) properties[name] = feature.p[attributeIndex]
  }
  return properties
}

function convertCartoVistaLayer(layer, bytes) {
  const cartoJson = JSON.parse(bytes.toString('utf8'))
  const features = []
  const bbox = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [index, feature] of (cartoJson.f ?? []).entries()) {
    const geometry = decodeCartoVistaGeometry(feature.g)
    boundsForGeometry(geometry, bbox)
    features.push({
      type: 'Feature',
      geometry,
      properties: propertiesForFeature(layer, cartoJson, feature, index),
    })
  }
  return {
    collection: {
      type: 'FeatureCollection',
      name: layer.id,
      features,
    },
    bbox,
    cartoVista: {
      featureCount: cartoJson.f?.length ?? 0,
      attributeDefinitions: cartoJson.attributeDefinitions ?? [],
      projection: cartoJson.proj ?? null,
    },
  }
}

async function writeGzipJson(filePath, payload) {
  const raw = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
  const gz = gzipSync(raw, { level: 9 })
  await writeFile(filePath, gz)
  return { rawBytes: raw.byteLength, gzipBytes: gz.byteLength }
}

function normalizeShapefileCollection(layer, sourceCollection) {
  return {
    type: 'FeatureCollection',
    name: layer.id,
    features: (sourceCollection.features ?? [])
      .filter((feature) => feature.geometry)
      .map((feature, index) => ({
        type: 'Feature',
        geometry: feature.geometry,
        properties: {
          ...(feature.properties ?? {}),
          id: feature.properties?.UniqueID ?? feature.properties?.id ?? String(index + 1),
          source: 'CRTC',
          sourceLayer: layer.id,
          sourceFile: layer.shapefileName,
          title: layer.title,
          category: layer.category,
          ...(layer.technology ? { technology: layer.technology } : {}),
          ...(layer.year ? { year: layer.year } : {}),
        },
      })),
  }
}

async function buildCartoVistaSnapshots() {
  const resources = []
  const coverageFeatures = []
  const { bytes: shapeZipBytes, http: shapeZipHttp } = await fetchBytes(CRTC_SHAPE_ZIP_URL)
  const shapefileCollections = await shp(shapeZipBytes)
  const shapefileByName = new Map(shapefileCollections.map((collection) => [collection.fileName, collection]))

  for (const layer of cartovistaLayers) {
    const url = `${CRTC_CARTOVISTA_MAP_BASE}${layer.fileName}`
    const sourceCollection = shapefileByName.get(layer.shapefileName)
    if (!sourceCollection) throw new Error(`Missing ${layer.shapefileName} in ${CRTC_SHAPE_ZIP_URL}`)
    const collection = normalizeShapefileCollection(layer, sourceCollection)
    const bbox = [Infinity, Infinity, -Infinity, -Infinity]
    for (const feature of collection.features) boundsForGeometry(feature.geometry, bbox)
    const outputPath = path.join(OUTPUT_DIR, layer.outputName)
    const size = await writeGzipJson(outputPath, collection)
    if (layer.category === 'coverage') coverageFeatures.push(...collection.features)

    resources.push({
      ...layer,
      sourceUrl: url,
      shapefileSourceUrl: CRTC_SHAPE_ZIP_URL,
      path: layer.outputName,
      geometry: collection.features[0]?.geometry?.type ?? 'Unknown',
      featureCount: collection.features.length,
      bbox: bbox.every(Number.isFinite) ? bbox : null,
      rawBytes: size.rawBytes,
      gzipBytes: size.gzipBytes,
      sourceBundleRawBytes: shapeZipBytes.byteLength,
      http: shapeZipHttp,
    })
    console.log(`network-availability: ${layer.outputName} ${prettyBytes(size.rawBytes)} -> ${prettyBytes(size.gzipBytes)}`)
  }

  const combined = {
    type: 'FeatureCollection',
    name: 'crtc-wireless-coverage-current',
    features: coverageFeatures,
  }
  const combinedSize = await writeGzipJson(path.join(OUTPUT_DIR, 'crtc-wireless-coverage-current.geojson.gz'), combined)
  resources.unshift({
    id: 'crtc-wireless-coverage-current',
    title: 'CRTC dissolved LTE and 5G wireless coverage',
    source: 'CRTC',
    category: 'coverage',
    geometry: 'mixed polygon',
    formats: ['GeoJSON gzip'],
    path: 'crtc-wireless-coverage-current.geojson.gz',
    years: [2024],
    featureCount: coverageFeatures.length,
    rawBytes: combinedSize.rawBytes,
    gzipBytes: combinedSize.gzipBytes,
    notes:
      'App-ready local snapshot combining the CRTC CartoVista _5G_YE2024 and LTE_YE2024 dissolved multipart polygons. This is the preferred PGMaps network overlay source.',
  })

  return resources
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true })

  const [datasets, cartovistaResources] = await Promise.all([
    Promise.all(crtcDownloadSources.map(probeSource)),
    buildCartoVistaSnapshots(),
  ])

  const manifest = {
    generatedAt: new Date().toISOString(),
    title: 'Canada network availability vector sources',
    description:
      'Vector-first source inventory and app-ready CRTC CartoVista snapshots for Canadian mobile network availability. The CRTC NPAS CartoVista LTE/5G layers are already dissolved multipart polygons, which render as connected coverage regions; the NRCan layer is retained as a source reference but is grid/cell-like.',
    coverage: 'Canada',
    sourcePageUrl: CRTC_PAGE_URL,
    cartovistaAppUrl: CRTC_CARTOVISTA_APP_URL,
    cartovistaConfigUrl: CRTC_CARTOVISTA_CONFIG_URL,
    license:
      'CRTC/NRCan/Open Canada sources use Government of Canada public data terms; carrier and ISED sources are source-dependent and require attribution/terms review before redistribution.',
    recommendedUse:
      'Use crtc-wireless-coverage-current.geojson.gz for PGMaps wireless coverage rendering. Use the per-layer CartoVista snapshots for broadcast and road overlays. Use historical CRTC over-years ZIPs when a year slider is needed.',
    historicalCoverage:
      'Yes. The CRTC over-years packages expose 5G coverage for 2020-2024 and LTE coverage for 2013-2024. The NPAS CartoVista map itself uses the current YE2024 LTE/5G coverage layers.',
    datasets,
    cartovistaResources,
    carrierFindings,
  }

  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`network-availability: wrote manifest and ${cartovistaResources.length} CartoVista resources to ${OUTPUT_DIR}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
