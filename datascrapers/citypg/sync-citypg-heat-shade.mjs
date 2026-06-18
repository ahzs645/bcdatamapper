import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CITYPG_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(CITYPG_DIR, 'source', 'heat-shade')
const PAGE_SIZE = 2000

const DATASETS = [
  {
    id: 'citypg-trees',
    name: 'CityPG trees',
    url: 'https://services2.arcgis.com/CnkB6jCzAsyli34z/arcgis/rest/services/OpenData_ParkData/FeatureServer/0',
    output: `${OUTPUT_DIR}/citypg_trees.geojson`,
  },
  {
    id: 'citypg-park-open-spaces',
    name: 'CityPG park and open spaces',
    url: 'https://services2.arcgis.com/CnkB6jCzAsyli34z/arcgis/rest/services/OpenData_ParkData/FeatureServer/12',
    output: `${OUTPUT_DIR}/citypg_park_open_spaces.geojson`,
  },
  {
    id: 'citypg-intact-forest',
    name: 'CityPG intact forest',
    url: 'https://services2.arcgis.com/CnkB6jCzAsyli34z/arcgis/rest/services/OpenData_Ecology/FeatureServer/2',
    output: `${OUTPUT_DIR}/citypg_intact_forest.geojson`,
  },
  {
    id: 'citypg-community-forests',
    name: 'CityPG community forests',
    url: 'https://services2.arcgis.com/CnkB6jCzAsyli34z/arcgis/rest/services/OpenData_OCPLanduse/FeatureServer/37',
    output: `${OUTPUT_DIR}/citypg_community_forests.geojson`,
  },
  {
    id: 'citypg-community-facility',
    name: 'CityPG OCP community facility',
    url: 'https://services2.arcgis.com/CnkB6jCzAsyli34z/arcgis/rest/services/OpenData_OCPLanduse/FeatureServer/4',
    output: `${OUTPUT_DIR}/citypg_community_facility.geojson`,
  },
  {
    id: 'citypg-response-facilities',
    name: 'CityPG response facilities',
    url: 'https://services2.arcgis.com/CnkB6jCzAsyli34z/arcgis/rest/services/ResponseFacilities/FeatureServer/0',
    output: `${OUTPUT_DIR}/citypg_response_facilities.geojson`,
  },
]

function queryUrl(layerUrl, offset) {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: String(PAGE_SIZE),
    resultOffset: String(offset),
  })
  return `${layerUrl}/query?${params.toString()}`
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Failed to fetch ${url}: ${response.status} ${body.slice(0, 200)}`)
  }
  return response.json()
}

async function fetchLayer(dataset) {
  const features = []
  let offset = 0
  let template = null

  while (true) {
    const geojson = await fetchJson(queryUrl(dataset.url, offset))
    if (geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
      throw new Error(`${dataset.name} did not return a GeoJSON FeatureCollection`)
    }

    if (!template) template = { ...geojson, features }
    features.push(...geojson.features)
    if (!geojson.exceededTransferLimit || geojson.features.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return template ?? { type: 'FeatureCollection', features }
}

async function main() {
  for (const dataset of DATASETS) {
    const geojson = await fetchLayer(dataset)
    await mkdir(path.dirname(dataset.output), { recursive: true })
    await writeFile(dataset.output, `${JSON.stringify(geojson)}\n`)
    console.log(`${dataset.name}: wrote ${geojson.features.length} features to ${dataset.output}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
