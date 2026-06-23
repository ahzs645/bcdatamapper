import { copyFile, cp, mkdir, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeWmsRasterTileSet } from '../../../../scripts/lib/wms-raster-tile-utils.mjs'

const execFileAsync = promisify(execFile)
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = process.env.PGMAPS_ROOT
  ? path.resolve(process.env.PGMAPS_ROOT)
  : path.resolve(SCRIPT_DIR, '../../../..')
const VENDOR_DIR = path.join(PROJECT_ROOT, 'vendor/bcdatamapper/datascrapers/eccc/output')
const APP_DIR = path.join(PROJECT_ROOT, 'public/data/aqmap')
const VECTOR_OUTPUT_NAME = 'modelled-pm25-native-vector.geojson.gz'
const RASTER_TILE_DIR_NAME = 'modelled-pm25-raster-tiles'
const RASTER_TILE_ARCHIVE_NAME = `${RASTER_TILE_DIR_NAME}.tar.gz`
const VECTOR_VENDOR_PATH = path.join(VENDOR_DIR, VECTOR_OUTPUT_NAME)
const VECTOR_APP_PATH = path.join(APP_DIR, VECTOR_OUTPUT_NAME)
const RASTER_VENDOR_DIR = path.join(VENDOR_DIR, RASTER_TILE_DIR_NAME)
const RASTER_VENDOR_ARCHIVE_PATH = path.join(VENDOR_DIR, RASTER_TILE_ARCHIVE_NAME)
const RASTER_APP_DIR = path.join(APP_DIR, RASTER_TILE_DIR_NAME)

const GEOMET_BASE_URL = 'https://geo.weather.gc.ca/geomet'
const GEOMET_WMS_CAPABILITIES_URL = `${GEOMET_BASE_URL}?service=WMS&request=GetCapabilities&version=1.3.0`
const DATAMART_BASE = 'https://dd.weather.gc.ca/today/model_raqdps/10km/grib2'
const LAYER = 'RAQDPS.SFC_PM2.5'
const STYLE = 'PM2.5_0to100ugm3_Dis'
const TILE_MIN_ZOOM = 3
const TILE_MAX_ZOOM = 7
const TILE_CONCURRENCY = 12
const SNAPSHOT_BOUNDS = {
  west: -176.842409132,
  south: 16.149189226,
  east: -18.825681315,
  north: 80.210751469,
}

function parseArg(name) {
  const prefix = `--${name}=`
  const value = process.argv.find((arg) => arg.startsWith(prefix))
  return value ? value.slice(prefix.length) : null
}

function yyyymmdd(date) {
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

function hour(date) {
  return String(date.getUTCHours()).padStart(2, '0')
}

function forecastHour(start, valid) {
  const hours = Math.round((valid.getTime() - start.getTime()) / 3_600_000)
  if (hours < 0 || hours > 72) throw new Error(`Unexpected RAQDPS forecast hour: ${hours}`)
  return String(hours).padStart(3, '0')
}

function wmsTime(date) {
  return date.toISOString().replace('.000Z', 'Z')
}

function extractPm25TimeDimension(capabilities) {
  const layerIndex = capabilities.indexOf('<Name>RAQDPS.SFC_PM2.5</Name>')
  if (layerIndex === -1) throw new Error('Could not find RAQDPS.SFC_PM2.5 in WMS capabilities.')
  const nextLayerIndex = capabilities.indexOf('<Layer', layerIndex + 1)
  const layerXml = capabilities.slice(layerIndex, nextLayerIndex === -1 ? undefined : nextLayerIndex)
  const match = layerXml.match(/<Dimension[^>]*name="time"[^>]*default="([^"]+)"[^>]*>\s*([^/<]+)\/([^/<]+)\/PT1H\s*<\/Dimension>/)
  if (!match) throw new Error('Could not find RAQDPS.SFC_PM2.5 time dimension in WMS capabilities.')
  return {
    defaultTime: new Date(match[1]),
    runStart: new Date(match[2]),
    runEnd: new Date(match[3]),
  }
}

async function discoverSnapshot() {
  const explicitGribUrl = parseArg('grib-url')
  const explicitTime = parseArg('time')
  if (explicitGribUrl && explicitTime) {
    return {
      gribUrl: explicitGribUrl,
      time: new Date(explicitTime),
      runStart: null,
    }
  }
  if (explicitGribUrl || explicitTime) {
    throw new Error('Pass both --grib-url and --time, or neither.')
  }

  const response = await fetch(GEOMET_WMS_CAPABILITIES_URL)
  if (!response.ok) throw new Error(`WMS capabilities request failed: ${response.status} ${response.statusText}`)
  const dimension = extractPm25TimeDimension(await response.text())
  const run = hour(dimension.runStart)
  const hhh = forecastHour(dimension.runStart, dimension.defaultTime)
  const date = yyyymmdd(dimension.runStart)
  return {
    ...dimension,
    time: dimension.defaultTime,
    gribUrl: `${DATAMART_BASE}/${run}/${hhh}/${date}T${run}Z_MSC_RAQDPS_PM2.5_Sfc_RLatLon0.09_PT${hhh}H.grib2`,
  }
}

function buildWmsTileUrl({ bbox, time }) {
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.1.1',
    LAYERS: LAYER,
    STYLES: STYLE,
    FORMAT: 'image/png',
    TRANSPARENT: 'true',
    SRS: 'EPSG:3857',
    WIDTH: '256',
    HEIGHT: '256',
    BBOX: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    TIME: wmsTime(time),
  })
  return `${GEOMET_BASE_URL}?${params.toString()}`
}

async function buildVectorSnapshot({ gribUrl }) {
  const vectorizeScript = path.join(SCRIPT_DIR, 'lib/grib-grid-vectorize.py')
  await mkdir(path.dirname(VECTOR_VENDOR_PATH), { recursive: true })
  await mkdir(path.dirname(VECTOR_APP_PATH), { recursive: true })
  const { stdout, stderr } = await execFileAsync('python3', [
    vectorizeScript,
    '--input',
    gribUrl,
    '--output',
    VECTOR_VENDOR_PATH,
  ], { maxBuffer: 1024 * 1024 * 40 })
  if (stderr.trim()) console.warn(stderr.trim())
  await copyFile(VECTOR_VENDOR_PATH, VECTOR_APP_PATH)
  console.log(stdout.trim())
}

async function buildRasterSnapshot(snapshot) {
  const stats = await writeWmsRasterTileSet({
    bounds: SNAPSHOT_BOUNDS,
    buildUrl: ({ bbox }) => buildWmsTileUrl({ bbox, time: snapshot.time }),
    outputDir: RASTER_VENDOR_DIR,
    minZoom: TILE_MIN_ZOOM,
    maxZoom: TILE_MAX_ZOOM,
    concurrency: TILE_CONCURRENCY,
    manifest: {
      source: 'ECCC GeoMet WMS RAQDPS.SFC_PM2.5',
      layer: LAYER,
      style: STYLE,
      time: wmsTime(snapshot.time),
      gribSource: snapshot.gribUrl,
      bounds: SNAPSHOT_BOUNDS,
      tileScheme: 'xyz',
      format: 'image/png',
      note: 'Tiles are WMS-rendered PNG snapshots in EPSG:3857; transparent tiles are omitted. This raster snapshot is paired with modelled-pm25-native-vector.geojson.gz.',
    },
  })
  await execFileAsync('tar', [
    '-czf',
    RASTER_VENDOR_ARCHIVE_PATH,
    '-C',
    RASTER_VENDOR_DIR,
    '.',
  ], { maxBuffer: 1024 * 1024 * 20 })
  await rm(RASTER_VENDOR_DIR, { recursive: true, force: true })
  await rm(RASTER_APP_DIR, { recursive: true, force: true })
  await mkdir(RASTER_APP_DIR, { recursive: true })
  await execFileAsync('tar', [
    '-xzf',
    RASTER_VENDOR_ARCHIVE_PATH,
    '-C',
    RASTER_APP_DIR,
  ], { maxBuffer: 1024 * 1024 * 20 })
  return stats
}

async function main() {
  const snapshot = await discoverSnapshot()
  await buildVectorSnapshot(snapshot)
  const rasterStats = await buildRasterSnapshot(snapshot)
  console.log(`Source GRIB: ${snapshot.gribUrl}`)
  console.log(`Snapshot WMS time: ${wmsTime(snapshot.time)}`)
  if (snapshot.runStart) console.log(`Matched WMS default time ${snapshot.time.toISOString()} from run ${snapshot.runStart.toISOString()}`)
  console.log(`Copied ${path.relative(PROJECT_ROOT, VECTOR_VENDOR_PATH)} -> ${path.relative(PROJECT_ROOT, VECTOR_APP_PATH)}`)
  console.log(`Archived ${path.relative(PROJECT_ROOT, RASTER_VENDOR_ARCHIVE_PATH)} and extracted -> ${path.relative(PROJECT_ROOT, RASTER_APP_DIR)}`)
  console.log(
    `Wrote ${rasterStats.tileCount}/${rasterStats.candidateTileCount} PM2.5 raster snapshot tiles z${TILE_MIN_ZOOM}-${TILE_MAX_ZOOM} ` +
      `(${(rasterStats.bytes / 1e6).toFixed(2)} MB PNG, ${rasterStats.skippedTransparent} transparent skipped, ${rasterStats.failed} failed)`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
