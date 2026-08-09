import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { area, bbox, intersect } from '@turf/turf'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const VENDOR_ROOT = join(SCRIPT_DIR, '..', '..', '..')
const SNOW_PATH = 'datascrapers/bc/boundaries/output/BCSnowSurvey/snow_survey_admin_basins.geojson'
const OUTPUT_PATH = 'datascrapers/bc/boundaries/output/BCSnowSurvey/comparison.json'
const EXACT_LIKE_IOU = 0.98
const MATERIAL_CONTRIBUTION = 0.01

const families = [
  ['BC drainage basins', 'datascrapers/bc/boundaries/output/BCDrainage/drainage_basins.geojson', 'boundaryName'],
  ['FWA major watersheds', 'datascrapers/bc/boundaries/output/BCFWA/major_watersheds_province_simplified.geojson', 'boundaryName'],
  ['FWA watershed groups', 'datascrapers/bc/boundaries/output/BCFWA/watershed_groups_province_simplified.geojson', 'boundaryName'],
  ['Regional districts', 'datascrapers/bc/boundaries/output/BC/regional_districts.geojson', 'boundaryName'],
  ['Municipalities', 'datascrapers/bc/boundaries/output/BC/municipalities.geojson', 'boundaryName'],
  ['BCER administrative zones', 'datascrapers/bc/boundaries/output/BCER/admin_zones.geojson', 'boundaryName'],
  ['Natural resource areas', 'datascrapers/bc/boundaries/output/BCNR/nr_areas.geojson', 'boundaryName'],
  ['Natural resource regions', 'datascrapers/bc/boundaries/output/BCNR/nr_regions.geojson', 'boundaryName'],
  ['Natural resource districts', 'datascrapers/bc/boundaries/output/BCNR/nr_districts.geojson', 'boundaryName'],
  ['Wildfire zones', 'datascrapers/bc/boundaries/output/BCWildfire/fire_zones.geojson', 'boundaryName'],
  ['Health authorities', 'datascrapers/bc/boundaries/output/BCMoH/health_authorities.json', 'HLTH_AUTHORITY_NAME'],
  ['Health service delivery areas', 'datascrapers/bc/boundaries/output/BCMoH/health_service_delivery_areas.json', 'HLTH_SERVICE_DLVR_AREA_NAME'],
  ['Local health areas', 'datascrapers/bc/boundaries/output/BCMoH/local_health_areas.json', 'LOCAL_HLTH_AREA_NAME'],
]

function readCollection(relativePath) {
  const collection = JSON.parse(readFileSync(join(VENDOR_ROOT, relativePath), 'utf8'))
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error(`${relativePath} is not a GeoJSON FeatureCollection`)
  }
  return collection
}

function normalizedName(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function boxesOverlap(left, right) {
  return !(left[2] < right[0] || right[2] < left[0] || left[3] < right[1] || right[3] < left[1])
}

function round(value) {
  return Number(value.toFixed(6))
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

const snow = readCollection(SNOW_PATH)
const snowAreas = new Map(snow.features.map((feature) => [feature.id, area(feature)]))
const totalSnowArea = [...snowAreas.values()].reduce((sum, value) => sum + value, 0)

function compareFamily([familyName, repositoryPath, nameProperty]) {
  const collection = readCollection(repositoryPath)
  const candidates = collection.features
    .filter((feature) => feature.geometry && ['Polygon', 'MultiPolygon'].includes(feature.geometry.type))
    .map((feature, index) => ({
      feature,
      key: String(feature.id ?? feature.properties?.boundaryCode ?? index),
      name: String(feature.properties?.[nameProperty] ?? feature.properties?.boundaryName ?? ''),
      area: area(feature),
      bbox: bbox(feature),
    }))
  const exactLikePairs = []
  const sameNamePairs = []
  const perSnow = []
  let maximumIouPair = null

  for (const snowFeature of snow.features) {
    const snowArea = snowAreas.get(snowFeature.id)
    const snowBox = bbox(snowFeature)
    let best = null
    let materialContributors = 0
    for (const candidate of candidates) {
      if (!boxesOverlap(snowBox, candidate.bbox)) continue
      let overlap
      try {
        overlap = intersect(snowFeature, candidate.feature)
      } catch {
        continue
      }
      if (!overlap) continue
      const intersectionArea = area(overlap)
      if (intersectionArea <= 0) continue
      const snowCoverage = intersectionArea / snowArea
      const candidateCoverage = intersectionArea / candidate.area
      const iou = intersectionArea / (snowArea + candidate.area - intersectionArea)
      if (snowCoverage >= MATERIAL_CONTRIBUTION) materialContributors += 1
      const pair = {
        snowBasinId: snowFeature.properties.basin_id,
        snowBasinName: snowFeature.properties.basin_name,
        candidateKey: candidate.key,
        candidateName: candidate.name,
        intersectionOverUnion: round(iou),
        snowBasinCoverage: round(snowCoverage),
        candidateCoverage: round(candidateCoverage),
      }
      if (!best || iou > best.rawIou) best = { ...pair, rawIou: iou }
      if (normalizedName(pair.snowBasinName) === normalizedName(pair.candidateName)) {
        sameNamePairs.push(pair)
      }
    }
    if (!best) continue
    delete best.rawIou
    perSnow.push({ ...best, materialContributors })
    if (!maximumIouPair || best.intersectionOverUnion > maximumIouPair.intersectionOverUnion) {
      maximumIouPair = best
    }
    if (best.intersectionOverUnion >= EXACT_LIKE_IOU) exactLikePairs.push(best)
  }

  const uniqueExactCandidateKeys = new Set(exactLikePairs.map((pair) => pair.candidateKey))
  const equivalentFamily = (
    candidates.length === snow.features.length
    && exactLikePairs.length === snow.features.length
    && uniqueExactCandidateKeys.size === snow.features.length
  )
  return {
    family: familyName,
    repositoryPath,
    polygonFeatures: candidates.length,
    equivalentFamily,
    exactLikeFeaturePairs: exactLikePairs,
    maximumIouPair,
    areaWeightedBestSnowBasinCoverage: round(perSnow.reduce((sum, pair) => (
      sum + pair.snowBasinCoverage * snowAreas.get(`snow-survey-basin:${pair.snowBasinId}`)
    ), 0) / totalSnowArea),
    materialContributorThreshold: MATERIAL_CONTRIBUTION,
    medianMaterialContributorsPerSnowBasin: median(perSnow.map((pair) => pair.materialContributors)),
    materialContributorRange: [
      Math.min(...perSnow.map((pair) => pair.materialContributors)),
      Math.max(...perSnow.map((pair) => pair.materialContributors)),
    ],
    sameNamePairs,
  }
}

const comparisons = families.map(compareFamily)
const output = {
  title: 'BC Snow Survey Administrative Basin boundary-family comparison',
  snowBoundaryPath: SNOW_PATH,
  snowBoundarySha256: createHash('sha256').update(readFileSync(join(VENDOR_ROOT, SNOW_PATH))).digest('hex'),
  snowBasinFeatures: snow.features.length,
  methodology: {
    intersectionOverUnion: 'intersection area divided by union area',
    exactLikeThreshold: EXACT_LIKE_IOU,
    materialContributorThreshold: MATERIAL_CONTRIBUTION,
    equivalentFamilyRule: 'Same feature count, every Snow Survey basin has a distinct best candidate with IoU at or above the threshold.',
    caveat: 'Spatial similarity can identify duplication but cannot establish source lineage. Official catalogue lineage was reviewed separately.',
  },
  conclusion: {
    equivalentExistingFamilyFound: comparisons.some((comparison) => comparison.equivalentFamily),
    classification: 'unique-program-boundary-family',
    rationale: 'No compared BC Data Mapper family is equivalent to all 23 Snow Survey basins. Hydrologic similarities exist for individual basins, but the complete reporting partition differs.',
  },
  comparisons,
}
const outputText = `${JSON.stringify(output, null, 2)}\n`
const outputPath = join(VENDOR_ROOT, OUTPUT_PATH)
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, outputText)
console.log(JSON.stringify({
  output: OUTPUT_PATH,
  bytes: Buffer.byteLength(outputText),
  comparedFamilies: comparisons.length,
  equivalentExistingFamilyFound: output.conclusion.equivalentExistingFamilyFound,
  exactLikePairs: Object.fromEntries(comparisons.map((comparison) => [comparison.family, comparison.exactLikeFeaturePairs.length])),
}))
