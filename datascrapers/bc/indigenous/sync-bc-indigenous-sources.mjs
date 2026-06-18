import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import simplify from '@turf/simplify'
import { SNAPSHOT_DIR, copySnapshotToPublic } from './indigenous-snapshot.mjs'

// Write generated layers into the committed snapshot in the submodule, then copy them
// into the PGMaps public/ dir. The snapshot is the version-controlled source of truth.
const OUTPUT_DIR = SNAPSHOT_DIR
const CKAN_BASE = 'https://catalogue.data.gov.bc.ca/api/3/action/package_show'
const OPEN_CANADA_BASE = 'https://open.canada.ca/data/api/action/package_show'
const WFS_BASE = 'https://openmaps.gov.bc.ca/geo/pub'
const SIMPLIFY_TOLERANCE = 0.0002

const CAD_PACKAGE_ID = 'profiles-of-indigenous-peoples-pip-consultation-areas-public-map-service'
const COMMUNITY_PACKAGE_ID = 'first-nation-community-locations'
const TREATY_AREA_PACKAGE_ID = 'first-nations-treaty-areas'
const CAD_PUBLIC_APP_URL = 'https://maps.gov.bc.ca/ess/hm/cadb/'
const CAD_OPERATIONAL_SERVICE_URL = 'https://maps.gov.bc.ca/arcserver/rest/services/mpcm/bcgw/MapServer'
const CAD_LAYER_382_DYNAMIC_DEFINITION = {
  id: 382,
  source: {
    type: 'dataLayer',
    dataSource: {
      type: 'table',
      workspaceId: 'MPCM_ALL_PUB',
      dataSourceName: 'WHSE_ADMIN_BOUNDARIES.ADM_INDIAN_RESERVES_BANDS_SP',
      gdbVersion: '',
    },
  },
}

const WFS_DATASETS = [
  {
    id: 'first_nation_community_locations',
    title: 'First Nation Community Locations',
    packageId: COMMUNITY_PACKAGE_ID,
    typeName: 'WHSE_HUMAN_CULTURAL_ECONOMIC.FN_COMMUNITY_LOCATIONS_SP',
    geometryType: 'Point',
    output: 'first_nation_community_locations.geojson',
    caveat: 'Approximate community/office locations and administrative reference data. Not a traditional territory or acknowledgement boundary layer.',
  },
  {
    id: 'first_nations_treaty_areas',
    title: 'First Nations Treaty Areas',
    packageId: TREATY_AREA_PACKAGE_ID,
    typeName: 'WHSE_LEGAL_ADMIN_BOUNDARIES.FNT_TREATY_AREA_SP',
    geometryType: 'Polygon',
    output: 'first_nations_treaty_areas.geojson',
    simplify: true,
    caveat: 'Treaty-defined legal/admin geography where available. Not a comprehensive traditional territory layer.',
  },
]

const ARCGIS_DATASETS = [
  {
    id: 'first_nations_treaty_lands',
    title: 'First Nations Treaty Lands',
    url: 'https://delivery.maps.gov.bc.ca/arcgis/rest/services/whse/bcgw_pub_whse_legal_admin_boundaries/MapServer/19',
    output: 'first_nations_treaty_lands.geojson',
    simplify: true,
    caveat: 'Treaty land polygons where official treaty data is available. Not a comprehensive traditional territory layer.',
  },
  {
    id: 'indian_reserves_band_names',
    title: 'Indian Reserves & Band Names - Administrative Boundaries',
    url: 'https://delivery.maps.gov.bc.ca/arcgis/rest/services/mpcm/bcgwpub/MapServer/34',
    output: 'indian_reserves_band_names.geojson',
    simplify: true,
    caveat: 'Reserve and band-name administrative geography. Not traditional territory or acknowledgement wording.',
  },
]

const DYNAMIC_ARCGIS_DATASETS = [
  {
    id: 'cad_pip_layer_382_indian_reserves_band_names',
    title: 'CAD/PIP layer 382 - Indian Reserves including Band Names',
    packageId: CAD_PACKAGE_ID,
    url: CAD_OPERATIONAL_SERVICE_URL,
    sourceLayer: 'layers=show:382',
    dynamicDefinition: CAD_LAYER_382_DYNAMIC_DEFINITION,
    output: 'cad_pip_layer_382_indian_reserves_band_names.geojson',
    simplify: true,
    caveat: 'Pulled from the CAD/PIP operational MapServer dynamic layer 382 for offline use. The public CAD viewer resolves this layer to WHSE_ADMIN_BOUNDARIES.ADM_INDIAN_RESERVES_BANDS_SP (Indian Reserves including Band Names). This is reserve/band-name administrative geography, not the hidden CAD consultation-area polygons or acknowledgement wording.',
  },
]

const FEDERAL_ARCGIS_DATASETS = [
  {
    id: 'canada_first_nations_location',
    title: 'First Nations Location',
    packageId: 'b6567c5c-8339-4055-99fa-63f92114d9e4',
    url: 'https://geo.sac-isc.gc.ca/geomatics/rest/services/Donnees_Ouvertes-Open_Data/Premiere_Nation_First_Nation/MapServer/0',
    output: 'canada_first_nations_location.geojson',
    caveat: 'National First Nation point/name reference from ISC/CIRNAC. Points represent community/admin locations, not territory or acknowledgement boundaries.',
  },
]

const MANUAL_SOURCES = [
  {
    id: 'cad_pip_consultation_areas',
    title: 'Profiles of Indigenous Peoples (PIP): Consultation Areas - Public Map Service',
    packageId: CAD_PACKAGE_ID,
    url: CAD_PUBLIC_APP_URL,
    access: 'manual',
    caveat: 'Access-only interactive CAD/PIP report workflow. The public app can return preliminary First Nation contact reports, but the consultation-area boundary geometry is not displayed or offered as a downloadable public layer.',
  },
  {
    id: 'first_peoples_map_bc',
    title: 'First Peoples Map of B.C.',
    url: 'https://maps.fpcc.ca/',
    access: 'permission_required',
    caveat: 'Community-contributed cultural, language, and place context. Do not scrape; request API/data permission from FPCC before automation.',
  },
]

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`)
  }
  return response.json()
}

async function fetchPackage(id) {
  const url = `${CKAN_BASE}?id=${encodeURIComponent(id)}`
  const data = await fetchJson(url)
  if (!data.success) throw new Error(`BC Data Catalogue package lookup failed for ${id}`)
  return data.result
}

async function fetchOpenCanadaPackage(id) {
  const url = `${OPEN_CANADA_BASE}?id=${encodeURIComponent(id)}`
  const data = await fetchJson(url)
  if (!data.success) throw new Error(`Open Canada package lookup failed for ${id}`)
  return data.result
}

function packageSummary(pkg) {
  if (!pkg) return null
  return {
    id: pkg.id,
    name: pkg.name,
    title: pkg.title,
    license: pkg.license_title,
    metadataModified: pkg.metadata_modified,
    resources: (pkg.resources ?? []).map((resource) => ({
      name: resource.name,
      format: resource.format,
      url: resource.url,
    })),
  }
}

function openCanadaPackageSummary(pkg) {
  if (!pkg) return null
  return {
    id: pkg.id,
    name: pkg.name,
    title: pkg.title_translated?.en ?? pkg.title,
    license: pkg.license_title,
    metadataModified: pkg.metadata_modified,
    resources: (pkg.resources ?? []).map((resource) => ({
      name: resource.name,
      format: resource.format,
      url: resource.url,
    })),
  }
}

function wfsUrl(dataset) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '1.0.0',
    request: 'GetFeature',
    typeName: `pub:${dataset.typeName}`,
    outputFormat: 'json',
    srsName: 'EPSG:4326',
    maxFeatures: '50000',
  })
  return `${WFS_BASE}/${dataset.typeName}/ows?${params.toString()}`
}

function normalizeFeatureCollection(source, metadata) {
  return {
    type: 'FeatureCollection',
    name: metadata.id,
    metadata,
    features: Array.isArray(source.features) ? source.features : [],
  }
}

function maybeSimplifyFeatures(features, dataset) {
  if (!dataset.simplify) return features
  return features.map((feature) => {
    if (!feature.geometry || (feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon')) {
      return feature
    }
    try {
      return simplify(feature, {
        tolerance: SIMPLIFY_TOLERANCE,
        highQuality: false,
        mutate: false,
      })
    } catch {
      return feature
    }
  })
}

async function syncWfsDataset(dataset, packages) {
  const url = wfsUrl(dataset)
  const source = await fetchJson(url)
  const features = maybeSimplifyFeatures(Array.isArray(source.features) ? source.features : [], dataset)
  const collection = normalizeFeatureCollection(source, {
    id: dataset.id,
    title: dataset.title,
    source: 'BC Geographic Warehouse WFS',
    sourceLayer: dataset.typeName,
    sourceUrl: url,
    sourcePackage: packageSummary(packages.get(dataset.packageId)),
    geometryType: dataset.geometryType,
    generalized: Boolean(dataset.simplify),
    simplifyToleranceDegrees: dataset.simplify ? SIMPLIFY_TOLERANCE : null,
    caveat: dataset.caveat,
    generatedAt: new Date().toISOString(),
  })
  collection.features = features

  const outputPath = path.join(OUTPUT_DIR, dataset.output)
  await writeFile(outputPath, `${JSON.stringify(collection)}\n`)
  console.log(`${dataset.title}: wrote ${collection.features.length} features to ${outputPath}`)

  return {
    id: dataset.id,
    title: dataset.title,
    output: `/data/indigenous/${dataset.output}`,
    featureCount: collection.features.length,
    access: 'automated',
    source: collection.metadata.source,
    sourceLayer: dataset.typeName,
    sourceUrl: url,
    generalized: Boolean(dataset.simplify),
    simplifyToleranceDegrees: dataset.simplify ? SIMPLIFY_TOLERANCE : null,
    caveat: dataset.caveat,
  }
}

function arcGisQueryUrl(dataset, offset) {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: '1000',
    resultOffset: String(offset),
    orderByFields: 'OBJECTID',
  })
  return `${dataset.url}/query?${params.toString()}`
}

function dynamicArcGisQueryUrl(dataset, offset) {
  const params = new URLSearchParams({
    layer: JSON.stringify(dataset.dynamicDefinition),
    where: '1=1',
    outFields: '*',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: '1000',
    resultOffset: String(offset),
    orderByFields: 'OBJECTID',
  })
  return `${dataset.url}/dynamicLayer/query?${params.toString()}`
}

async function syncArcGisDataset(dataset, options = {}) {
  const features = []
  let offset = 0
  let template = null
  let exceededTransferLimit = true

  while (exceededTransferLimit) {
    const page = await fetchJson(arcGisQueryUrl(dataset, offset))
    if (page.type !== 'FeatureCollection' || !Array.isArray(page.features)) {
      throw new Error(`${dataset.title} did not return a GeoJSON FeatureCollection`)
    }
    if (!template) template = { ...page, features }
    features.push(...page.features)
    exceededTransferLimit = Boolean(page.exceededTransferLimit) && page.features.length > 0
    offset += page.features.length
  }

  const outputFeatures = maybeSimplifyFeatures(features, dataset)
  const collection = normalizeFeatureCollection(template ?? { type: 'FeatureCollection', features: outputFeatures }, {
    id: dataset.id,
    title: dataset.title,
    source: options.source ?? 'BC ArcGIS REST service',
    sourceUrl: dataset.url,
    sourcePackage: options.sourcePackage ?? null,
    generalized: Boolean(dataset.simplify),
    simplifyToleranceDegrees: dataset.simplify ? SIMPLIFY_TOLERANCE : null,
    caveat: dataset.caveat,
    generatedAt: new Date().toISOString(),
  })
  collection.features = outputFeatures

  const outputPath = path.join(OUTPUT_DIR, dataset.output)
  await writeFile(outputPath, `${JSON.stringify(collection)}\n`)
  console.log(`${dataset.title}: wrote ${collection.features.length} features to ${outputPath}`)

  return {
    id: dataset.id,
    title: dataset.title,
    output: `/data/indigenous/${dataset.output}`,
    featureCount: collection.features.length,
    access: 'automated',
    source: collection.metadata.source,
    sourceUrl: dataset.url,
    generalized: Boolean(dataset.simplify),
    simplifyToleranceDegrees: dataset.simplify ? SIMPLIFY_TOLERANCE : null,
    caveat: dataset.caveat,
  }
}

async function syncDynamicArcGisDataset(dataset, options = {}) {
  const features = []
  let offset = 0
  let template = null
  let exceededTransferLimit = true

  while (exceededTransferLimit) {
    const page = await fetchJson(dynamicArcGisQueryUrl(dataset, offset))
    if (page.type !== 'FeatureCollection' || !Array.isArray(page.features)) {
      throw new Error(`${dataset.title} did not return a GeoJSON FeatureCollection`)
    }
    if (!template) template = { ...page, features }
    features.push(...page.features)
    exceededTransferLimit = Boolean(page.exceededTransferLimit) && page.features.length > 0
    offset += page.features.length
  }

  const outputFeatures = maybeSimplifyFeatures(features, dataset)
  const collection = normalizeFeatureCollection(template ?? { type: 'FeatureCollection', features: outputFeatures }, {
    id: dataset.id,
    title: dataset.title,
    source: options.source ?? 'BC ArcGIS REST dynamic layer query',
    sourceUrl: dataset.url,
    sourceLayer: dataset.sourceLayer,
    sourcePackage: options.sourcePackage ?? null,
    dynamicDefinition: dataset.dynamicDefinition,
    generalized: Boolean(dataset.simplify),
    simplifyToleranceDegrees: dataset.simplify ? SIMPLIFY_TOLERANCE : null,
    caveat: dataset.caveat,
    generatedAt: new Date().toISOString(),
  })
  collection.features = outputFeatures

  const outputPath = path.join(OUTPUT_DIR, dataset.output)
  await writeFile(outputPath, `${JSON.stringify(collection)}\n`)
  console.log(`${dataset.title}: wrote ${collection.features.length} features to ${outputPath}`)

  return {
    id: dataset.id,
    title: dataset.title,
    output: `/data/indigenous/${dataset.output}`,
    featureCount: collection.features.length,
    access: 'automated',
    source: collection.metadata.source,
    sourceUrl: dataset.url,
    sourceLayer: dataset.sourceLayer,
    generalized: Boolean(dataset.simplify),
    simplifyToleranceDegrees: dataset.simplify ? SIMPLIFY_TOLERANCE : null,
    caveat: dataset.caveat,
  }
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true })

  const packageIds = new Set([
    ...MANUAL_SOURCES.map((source) => source.packageId),
    ...WFS_DATASETS.map((source) => source.packageId),
    ...DYNAMIC_ARCGIS_DATASETS.map((source) => source.packageId),
  ].filter(Boolean))
  const openCanadaPackageIds = new Set([
    ...FEDERAL_ARCGIS_DATASETS.map((source) => source.packageId),
  ])
  const packages = new Map()
  for (const id of packageIds) {
    packages.set(id, await fetchPackage(id))
  }
  const openCanadaPackages = new Map()
  for (const id of openCanadaPackageIds) {
    openCanadaPackages.set(id, await fetchOpenCanadaPackage(id))
  }

  const automated = []
  for (const dataset of WFS_DATASETS) {
    automated.push(await syncWfsDataset(dataset, packages))
  }
  for (const dataset of ARCGIS_DATASETS) {
    automated.push(await syncArcGisDataset(dataset))
  }
  for (const dataset of DYNAMIC_ARCGIS_DATASETS) {
    automated.push(await syncDynamicArcGisDataset(dataset, {
      sourcePackage: packageSummary(packages.get(dataset.packageId)),
    }))
  }
  for (const dataset of FEDERAL_ARCGIS_DATASETS) {
    automated.push(await syncArcGisDataset(dataset, {
      source: 'Government of Canada ArcGIS REST service',
      sourcePackage: openCanadaPackageSummary(openCanadaPackages.get(dataset.packageId)),
    }))
  }

  const manual = MANUAL_SOURCES.map((source) => ({
    ...source,
    sourcePackage: source.packageId ? packageSummary(packages.get(source.packageId)) : null,
  }))

  const manifest = {
    generatedAt: new Date().toISOString(),
    notes: [
      'CAD/PIP consultation areas are not bulk-downloaded because the public catalogue exposes an access-only application/report workflow, not downloadable consultation-area boundary geometry. The related ArcGIS MapServer dynamic layer 382 is bundled for offline use; the public CAD viewer resolves it to Indian reserves/band-name administrative geography, not consultation-area polygons.',
      'Automated layers are supporting context only. They do not determine Indigenous title, traditional territory, or acknowledgement wording.',
      'Polygon GeoJSON outputs are generalized with turf.simplify for app/dev use. They are committed as a snapshot in the bcdatamapper submodule (datascrapers/bc/indigenous/snapshot); rerun npm run indigenous:sync to refresh them from source services, then commit the updated snapshot.',
    ],
    automated,
    manual,
  }

  await writeFile(path.join(OUTPUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`manifest: wrote ${automated.length} automated sources and ${manual.length} manual sources`)

  const { dest, files } = await copySnapshotToPublic()
  console.log(`indigenous: copied ${files.length} snapshot file(s) to ${dest}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
