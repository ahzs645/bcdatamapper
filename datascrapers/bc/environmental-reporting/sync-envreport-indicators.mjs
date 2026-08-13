import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import {
  simplifyPolygonTopology,
  TOPOLOGY_PROFILES,
} from '../../lib/mapshaper-topology.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const VENDOR_ROOT = join(SCRIPT_DIR, '..', '..', '..')
const OUTPUT_DIR = join(VENDOR_ROOT, 'datascrapers/bc/environmental-reporting/output')
const PUBLIC_PATHS = {
  grizzly: '/data/boundaries/BCWildlife/grizzly_bear_population_units_2018.geojson',
  invasive: '/data/boundaries/BCEcology/ecological_drainage_units_aquatic_invasive_species.geojson',
  regionalDistricts: '/data/bc/environmental-reporting/regional_district_environmental_indicators.json',
}
const CENSUS_DIVISIONS_PATH = join(
  VENDOR_ROOT,
  'datascrapers/census/output/bc-da-simplified/parents/cd.geojson',
)

const SOURCES = {
  grizzlyUnits:
    'https://openmaps.gov.bc.ca/geo/pub/WHSE_WILDLIFE_INVENTORY.GCPB_GRIZZLY_BEAR_POP_UNITS_SP/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=WHSE_WILDLIFE_INVENTORY.GCPB_GRIZZLY_BEAR_POP_UNITS_SP&outputFormat=application%2Fjson&srsName=EPSG%3A4326',
  grizzlyRanks:
    'https://catalogue.data.gov.bc.ca/dataset/e08876a1-3f9c-46bf-b69a-3d88de1da725/resource/7282667b-185a-4f08-9d99-13a2e5ada1d4/download/grizzlybear_2019_conservationranking_results.csv',
  grizzlyPopulation:
    'https://catalogue.data.gov.bc.ca/dataset/2bf91935-9158-4f77-9c2c-4310480e6c29/resource/6406840f-9525-4544-9c36-e725fb2e399a/download/bc_grizzly_population_estimates_2015_and_2018_by_gbpu_population_units.csv',
  grizzlyMortality:
    'https://catalogue.data.gov.bc.ca/dataset/4bc13aa2-80c9-441b-8f46-0b9574109b93/resource/c5fc42c7-67d3-4669-b281-61dc50fdef22/download/grizzlybearmortalityhistory_1976_2017.csv',
  invasiveOccurrences:
    'https://openmaps.gov.bc.ca/geo/pub/WHSE_FISH.FISH_AQUATIC_INVASIVE_SPCS_SP/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=WHSE_FISH.FISH_AQUATIC_INVASIVE_SPCS_SP&outputFormat=application%2Fjson&srsName=EPSG%3A4326',
  ecologicalDrainageUnits:
    'https://openmaps.gov.bc.ca/geo/pub/WHSE_LAND_AND_NATURAL_RESOURCE.EAUBC_ECO_DRAINAGE_UNITS_SP/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=WHSE_LAND_AND_NATURAL_RESOURCE.EAUBC_ECO_DRAINAGE_UNITS_SP&outputFormat=application%2Fjson&srsName=EPSG%3A4326',
  municipalSolidWaste:
    'https://catalogue.data.gov.bc.ca/dataset/d21ed158-0ac7-4afd-a03b-ce22df0096bc/resource/d2648733-e484-40f2-b589-48192c16686b/download/bc_municipal_solid_waste_disposal.csv',
  regionalDistrictPopulation:
    'https://catalogue.data.gov.bc.ca/dataset/86839277-986a-4a29-9f70-fa9b1166f6cb/resource/36610a52-6f90-4ed6-946d-587641a490df/download/regional-district-population.csv',
}

const INDICATORS = {
  grizzly:
    'https://www.env.gov.bc.ca/soe/indicators/plants-and-animals/grizzly-bears.html',
  invasive:
    'https://www.env.gov.bc.ca/soe/indicators/plants-and-animals/invasive-species.html',
  waste:
    'https://www.env.gov.bc.ca/soe/indicators/sustainability/municipal-solid-waste.html',
  population:
    'https://www.env.gov.bc.ca/soe/indicators/sustainability/bc-population.html',
}

function parseCsv(text) {
  const records = []
  let record = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') quoted = false
      else field += character
    } else if (character === '"') quoted = true
    else if (character === ',') {
      record.push(field)
      field = ''
    } else if (character === '\n') {
      record.push(field.replace(/\r$/, ''))
      if (record.some(Boolean)) records.push(record)
      record = []
      field = ''
    } else field += character
  }
  if (field || record.length) {
    record.push(field.replace(/\r$/, ''))
    if (record.some(Boolean)) records.push(record)
  }
  const [headers, ...rows] = records
  return rows.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])),
  )
}

async function fetchText(url, label) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to fetch ${label}: ${response.status}`)
  return response.text()
}

async function fetchJson(url, label) {
  return JSON.parse(await fetchText(url, label))
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function round(value, digits = 0) {
  if (!Number.isFinite(value)) return null
  const multiplier = 10 ** digits
  return Math.round(value * multiplier) / multiplier
}

function formatNumber(value, digits = 0) {
  return Number(value).toLocaleString('en-CA', { maximumFractionDigits: digits })
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex')
}

function writeGeoJson(name, value) {
  const payload = `${JSON.stringify(value)}\n`
  const path = join(OUTPUT_DIR, name)
  writeFileSync(path, payload)
  return {
    file: name,
    features: value.features.length,
    bytes: Buffer.byteLength(payload),
    gzipBytes: gzipSync(payload).length,
    sha256: hash(payload),
  }
}

function writeJson(name, value, recordCount) {
  const payload = `${JSON.stringify(value)}\n`
  const path = join(OUTPUT_DIR, name)
  writeFileSync(path, payload)
  return {
    file: name,
    records: recordCount,
    bytes: Buffer.byteLength(payload),
    gzipBytes: gzipSync(payload).length,
    sha256: hash(payload),
  }
}

function geometryBounds(geometry) {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  const visit = (coordinates) => {
    if (typeof coordinates[0] === 'number') {
      const [x, y] = coordinates
      west = Math.min(west, x)
      south = Math.min(south, y)
      east = Math.max(east, x)
      north = Math.max(north, y)
      return
    }
    for (const child of coordinates) visit(child)
  }
  visit(geometry.coordinates)
  return [west, south, east, north]
}

function pointInBounds([x, y], [west, south, east, north]) {
  return x >= west && x <= east && y >= south && y <= north
}

function squaredDistanceToBounds([x, y], [west, south, east, north]) {
  const dx = x < west ? west - x : x > east ? x - east : 0
  const dy = y < south ? south - y : y > north ? y - north : 0
  return dx * dx + dy * dy
}

function asMultiPolygon(geometries) {
  const coordinates = geometries.flatMap((geometry) => {
    if (geometry.type === 'Polygon') return [geometry.coordinates]
    if (geometry.type === 'MultiPolygon') return geometry.coordinates
    throw new Error(`Unsupported polygon geometry: ${geometry.type}`)
  })
  return { type: 'MultiPolygon', coordinates }
}

function conservationRank(code) {
  return {
    M1: 'Extreme',
    M2: 'High',
    M3: 'Moderate',
    M4: 'Low',
    M5: 'Negligible',
  }[code] ?? 'Extirpated'
}

function densityBand(value, status) {
  if (status === 'Extirpated' || !Number.isFinite(value)) return 'Extirpated / no estimate'
  if (value < 5) return 'Fewer than 5'
  if (value < 10) return '5–9'
  if (value < 20) return '10–19'
  if (value < 30) return '20–29'
  return '30 or more'
}

function mortalityBand(value) {
  if (value === 0) return '0'
  if (value < 50) return '1–49'
  if (value < 100) return '50–99'
  if (value < 250) return '100–249'
  return '250 or more'
}

async function buildGrizzlyLayer() {
  const [unitSource, rankText, populationText, mortalityText] = await Promise.all([
    fetchJson(SOURCES.grizzlyUnits, 'grizzly bear population units'),
    fetchText(SOURCES.grizzlyRanks, 'grizzly bear conservation ranks'),
    fetchText(SOURCES.grizzlyPopulation, 'grizzly bear population estimates'),
    fetchText(SOURCES.grizzlyMortality, 'grizzly bear mortality history'),
  ])
  const ranks = parseCsv(rankText)
  const populations = parseCsv(populationText)
  const mortalities = parseCsv(mortalityText)
  const rankByName = new Map(ranks.map((row) => [row.GBPU.trim(), row]))
  const populationByName = new Map(populations.map((row) => [row.POPULATION_NAME.trim(), row]))
  const mortalityByTag = new Map()
  for (const row of mortalities) {
    const tag = String(row.GBPU_ID)
    const summary = mortalityByTag.get(tag) ?? {
      count: 0,
      firstYear: Infinity,
      lastYear: -Infinity,
      causes: new Map(),
    }
    summary.count += 1
    const year = number(row.HUNT_YEAR)
    if (year !== null) {
      summary.firstYear = Math.min(summary.firstYear, year)
      summary.lastYear = Math.max(summary.lastYear, year)
    }
    const cause = row.KILL_CODE || 'Unknown'
    summary.causes.set(cause, (summary.causes.get(cause) ?? 0) + 1)
    mortalityByTag.set(tag, summary)
  }
  const extirpatedNames = new Map([
    ['47', 'Northeast'],
    ['48', 'Central Interior'],
    ['53', 'Lower Mainland'],
    ['81', 'Sunshine Coast'],
  ])
  const units2018 = unitSource.features.filter(
    (feature) => String(feature.properties.VERSION_NAME) === '2018',
  )
  if (units2018.length !== 59) {
    throw new Error(`Expected 59 grizzly population-unit features, received ${units2018.length}`)
  }
  const features = units2018.map((feature) => {
    const source = feature.properties
    const tag = String(source.GRIZZLY_BEAR_POPULATION_TAG)
    const sourceName = String(source.POPULATION_NAME ?? '').trim()
    const name = sourceName || extirpatedNames.get(tag) || `Extirpated unit ${tag}`
    const rank = rankByName.get(name)
    const population = populationByName.get(name)
    const rankName = conservationRank(rank?.CalcSRank)
    const overallThreat = rank?.Overal_Threat === 'VHigh'
      ? 'Very High'
      : rank?.Overal_Threat || 'Not ranked'
    const populationEstimate = number(population?.GBPU_EST_POP_2018 ?? rank?.PopnEst2018)
    const populationDensity = number(population?.GBPU_EST_POP_DENSITY_2018)
    const mortality = mortalityByTag.get(tag)
    const mortalityCount = mortality?.count ?? 0
    const causeSummary = mortality
      ? [...mortality.causes.entries()]
          .sort((left, right) => right[1] - left[1])
          .map(([cause, count]) => `${cause}: ${formatNumber(count)}`)
          .join('; ')
      : 'No mortality records'
    const threats = [
      ['Residential', rank?.ResidentialCalc],
      ['Agriculture', rank?.AgricultureCalc],
      ['Energy and mining', rank?.EnergyCalc],
      ['Transportation', rank?.TransportationCalc],
      ['Biological use', rank?.BioUseCalc],
      ['Human intrusion', rank?.HumanIntrusionCalc],
      ['Climate change', rank?.ClimateChangeCalc],
    ].filter(([, value]) => value)
    const threatSummary = threats.map(([label, value]) => `${label}: ${value}`).join('; ')
    return {
      type: 'Feature',
      id: tag,
      geometry: feature.geometry,
      properties: {
        id: tag,
        gbpu_name: name,
        status: rankName === 'Extirpated' ? 'Extirpated' : String(source.STATUS || 'Viable'),
        conservation_rank: rankName,
        conservation_code: rank?.CalcSRank || null,
        conservation_display: `${name} · ${rankName} conservation rank`,
        population_2018: populationEstimate,
        density_2018_per_1000_km2: round(populationDensity, 1),
        density_band: densityBand(populationDensity, rankName),
        density_display: `${name} · ${populationDensity === null ? 'no density estimate' : `${round(populationDensity, 1)} bears / 1,000 km²`}`,
        trend: rank?.Trend || 'Data deficient',
        isolation_code: rank?.PopIso || null,
        overall_threat: overallThreat,
        threat_display: `${name} · ${overallThreat.toLowerCase()} overall threat`,
        mortality_1976_2017: mortalityCount,
        mortality_band: mortalityBand(mortalityCount),
        mortality_display: `${name} · ${formatNumber(mortalityCount)} recorded mortalities`,
        conservation_details: [
          `Conservation rank: ${rankName}${rank?.CalcSRank ? ` (${rank.CalcSRank})` : ''}.`,
          `2018 population estimate: ${populationEstimate === null ? 'not available' : formatNumber(populationEstimate)}.`,
          `Population trend: ${rank?.Trend || 'data deficient'}.`,
          `Population/isolation code: ${rank?.PopIso || 'not available'}.`,
        ].join('\n'),
        density_details: [
          `2018 population density: ${populationDensity === null ? 'not available' : `${round(populationDensity, 1)} adult bears per 1,000 km²`}.`,
          `2018 population estimate: ${populationEstimate === null ? 'not available' : formatNumber(populationEstimate)}.`,
          `Population-unit area excluding water and ice: ${population?.GBPU_AREA_KM2_noWaterIce ? `${formatNumber(population.GBPU_AREA_KM2_noWaterIce)} km²` : 'not available'}.`,
        ].join('\n'),
        threat_details: [
          `Overall threat: ${overallThreat}.`,
          threatSummary || 'Threat components were not ranked for this unit.',
        ].join('\n'),
        mortality_details: [
          `${formatNumber(mortalityCount)} grizzly bear mortality records from 1976–2017.`,
          mortality && Number.isFinite(mortality.firstYear)
            ? `Recorded years: ${mortality.firstYear}–${mortality.lastYear}.`
            : 'No recorded years.',
          causeSummary,
        ].join('\n'),
      },
    }
  })
  const simplified = simplifyPolygonTopology(
    { type: 'FeatureCollection', features },
    {
      toleranceMetres: 400,
      topologyProfile: TOPOLOGY_PROFILES.PARTITION,
      sourceCrs: 'EPSG:4326',
      workingCrs: 'EPSG:3005',
      outputCrs: 'EPSG:4326',
      coordinatePrecision: 6,
      tempPrefix: 'envreport-grizzly-',
    },
  )
  return {
    layer: {
      type: 'FeatureCollection',
      name: 'grizzly_bear_population_units_2018',
      metadata: {
        title: 'Grizzly Bear Conservation Ranking in B.C.',
        indicator: INDICATORS.grizzly,
        sources: [
          SOURCES.grizzlyUnits,
          SOURCES.grizzlyRanks,
          SOURCES.grizzlyPopulation,
          SOURCES.grizzlyMortality,
        ],
        populationYear: 2018,
        mortalityYears: '1976–2017',
        simplificationToleranceMetres: 400,
      },
      features: simplified.features.sort((left, right) =>
        left.properties.gbpu_name.localeCompare(right.properties.gbpu_name),
      ),
    },
    sourceStats: {
      unitFeatures: unitSource.features.length,
      unitFeatures2018: units2018.length,
      rankRows: ranks.length,
      populationRows: populations.length,
      mortalityRows: mortalities.length,
      sourceHashes: {
        ranks: hash(rankText),
        population: hash(populationText),
        mortality: hash(mortalityText),
      },
    },
  }
}

function invasiveBand(value) {
  if (!value) return 'No records'
  if (value <= 3) return '1–3 species'
  if (value <= 7) return '4–7 species'
  if (value <= 15) return '8–15 species'
  return '16 or more species'
}

function fishBand(value) {
  if (!value) return 'No fish records'
  if (value <= 2) return '1–2 fish species'
  if (value <= 5) return '3–5 fish species'
  if (value <= 10) return '6–10 fish species'
  return '11 or more fish species'
}

async function buildInvasiveLayer() {
  const [occurrenceSource, unitSource] = await Promise.all([
    fetchJson(SOURCES.invasiveOccurrences, 'aquatic invasive species occurrences'),
    fetchJson(SOURCES.ecologicalDrainageUnits, 'ecological drainage units'),
  ])
  const unitParts = new Map()
  for (const feature of unitSource.features) {
    const name = String(feature.properties.ECO_DRAINAGE_UNIT).trim()
    const group = unitParts.get(name) ?? {
      name,
      freshwaterEcoregion: feature.properties.FRESHWATER_ECOREGION,
      ids: [],
      geometries: [],
      sourceFeatures: [],
    }
    group.ids.push(feature.properties.ECO_DRAINAGE_UNIT_ID)
    group.geometries.push(feature.geometry)
    group.sourceFeatures.push(feature)
    unitParts.set(name, group)
  }
  const units = [...unitParts.values()].map((unit) => {
    const geometry = asMultiPolygon(unit.geometries)
    return { ...unit, geometry, bounds: geometryBounds(geometry) }
  })
  if (units.length !== 36) {
    throw new Error(`Expected 36 ecological drainage units, received ${units.length}`)
  }
  const aggregates = new Map(
    units.map((unit) => [unit.name, { occurrences: 0, species: new Map(), byGroup: new Map() }]),
  )
  let nearestAssignedOccurrences = 0
  for (const feature of occurrenceSource.features) {
    const coordinates = feature.geometry?.coordinates
    if (!coordinates || feature.geometry.type !== 'Point') continue
    let unit = units.find(
      (candidate) =>
        pointInBounds(coordinates, candidate.bounds) &&
        candidate.sourceFeatures.some((part) => booleanPointInPolygon(coordinates, part)),
    )
    if (!unit) {
      unit = units.reduce((closest, candidate) =>
        squaredDistanceToBounds(coordinates, candidate.bounds) <
        squaredDistanceToBounds(coordinates, closest.bounds)
          ? candidate
          : closest,
      )
      nearestAssignedOccurrences += 1
    }
    const aggregate = aggregates.get(unit.name)
    const properties = feature.properties
    const group = String(properties.TAXONOMIC_GROUP || 'Other').trim()
    const scientific = String(properties.SCIENTIFIC_NAME || '').trim()
    const english = String(properties.ENGLISH_NAME || '').trim()
    const key = scientific || english
    if (!key) continue
    aggregate.occurrences += 1
    aggregate.species.set(key, english || scientific)
    const groupSpecies = aggregate.byGroup.get(group) ?? new Map()
    groupSpecies.set(key, english || scientific)
    aggregate.byGroup.set(group, groupSpecies)
  }
  const features = units.map((unit) => {
    const aggregate = aggregates.get(unit.name)
    const groupCounts = Object.fromEntries(
      [...aggregate.byGroup.entries()].map(([group, species]) => [group, species.size]),
    )
    const groupSummary = [...aggregate.byGroup.entries()]
      .sort((left, right) => right[1].size - left[1].size)
      .map(([group, species]) => `${group}: ${species.size}`)
      .join('; ')
    const fishSpecies = [...(aggregate.byGroup.get('Fish')?.values() ?? [])].sort()
    return {
      type: 'Feature',
      id: unit.name,
      geometry: unit.geometry,
      properties: {
        id: unit.name,
        edu_name: unit.name,
        freshwater_ecoregion: unit.freshwaterEcoregion,
        source_unit_ids: unit.ids.join(', '),
        occurrence_count: aggregate.occurrences,
        species_count: aggregate.species.size,
        species_band: invasiveBand(aggregate.species.size),
        fish_species_count: groupCounts.Fish ?? 0,
        fish_band: fishBand(groupCounts.Fish ?? 0),
        plant_species_count: groupCounts.Plant ?? 0,
        invertebrate_species_count: groupCounts.Invertebrate ?? 0,
        algae_species_count: groupCounts.Algae ?? 0,
        amphibian_species_count: groupCounts.Amphibian ?? 0,
        reptile_species_count: groupCounts.Reptile ?? 0,
        species_display: `${unit.name} · ${aggregate.species.size} known aquatic invasive species`,
        fish_display: `${unit.name} · ${groupCounts.Fish ?? 0} known invasive fish species`,
        species_details: [
          `${aggregate.species.size} distinct aquatic invasive species across ${formatNumber(aggregate.occurrences)} occurrence records.`,
          groupSummary || 'No mapped occurrence records.',
          `Freshwater ecoregion: ${unit.freshwaterEcoregion}.`,
        ].join('\n'),
        fish_details: [
          `${groupCounts.Fish ?? 0} distinct invasive fish species.`,
          fishSpecies.length ? fishSpecies.join(', ') : 'No mapped invasive fish records.',
          `All aquatic invasive groups: ${aggregate.species.size} species.`,
        ].join('\n'),
      },
    }
  })
  const simplified = simplifyPolygonTopology(
    { type: 'FeatureCollection', features },
    {
      toleranceMetres: 500,
      topologyProfile: TOPOLOGY_PROFILES.PARTITION,
      sourceCrs: 'EPSG:4326',
      workingCrs: 'EPSG:3005',
      outputCrs: 'EPSG:4326',
      coordinatePrecision: 6,
      tempPrefix: 'envreport-invasive-',
    },
  )
  return {
    layer: {
      type: 'FeatureCollection',
      name: 'aquatic_invasive_species_by_ecological_drainage_unit',
      metadata: {
        title: 'Status of Invasive Species in B.C.',
        indicator: INDICATORS.invasive,
        sources: [SOURCES.invasiveOccurrences, SOURCES.ecologicalDrainageUnits],
        note: 'The 2015 EnvReportBC repository method was rerun against the current public occurrence service.',
        sourceBoundaryFeatures: unitSource.features.length,
        ecologicalDrainageUnits: units.length,
        occurrenceFeatures: occurrenceSource.features.length,
        nearestAssignedOccurrences,
        simplificationToleranceMetres: 500,
      },
      features: simplified.features.sort((left, right) =>
        left.properties.edu_name.localeCompare(right.properties.edu_name),
      ),
    },
    sourceStats: {
      occurrenceFeatures: occurrenceSource.features.length,
      sourceBoundaryFeatures: unitSource.features.length,
      ecologicalDrainageUnits: units.length,
      nearestAssignedOccurrences,
    },
  }
}

function wasteBand(value) {
  if (!Number.isFinite(value)) return 'No reported rate'
  if (value < 400) return 'Under 400 kg/person'
  if (value < 500) return '400–499 kg/person'
  if (value < 600) return '500–599 kg/person'
  if (value < 700) return '600–699 kg/person'
  return '700 kg/person or more'
}

function wasteChangeBand(value) {
  if (!Number.isFinite(value)) return 'No comparable data'
  if (value <= -20) return 'Decrease of 20% or more'
  if (value < -5) return 'Decrease of 5–19%'
  if (value <= 5) return 'Little change (±5%)'
  if (value < 20) return 'Increase of 6–19%'
  return 'Increase of 20% or more'
}

function populationBand(value) {
  if (value < 10_000) return 'Under 10,000'
  if (value < 50_000) return '10,000–49,999'
  if (value < 100_000) return '50,000–99,999'
  if (value < 500_000) return '100,000–499,999'
  return '500,000 or more'
}

function populationDensityBand(value) {
  if (value < 1) return 'Under 1 person/km²'
  if (value < 10) return '1–9 people/km²'
  if (value < 50) return '10–49 people/km²'
  if (value < 200) return '50–199 people/km²'
  return '200 people/km² or more'
}

function populationChangeBand(value) {
  if (value < 0) return 'Population decrease'
  if (value < 25) return 'Increase under 25%'
  if (value < 50) return 'Increase of 25–49%'
  if (value < 100) return 'Increase of 50–99%'
  return 'Population doubled or more'
}

function normalizedPopulationName(boundaryName) {
  return {
    'Greater Vancouver': 'Metro Vancouver',
    'Powell River': 'qathet',
    'Skeena-Queen Charlotte': 'North Coast',
    'Columbia-Shuswap': 'Columbia Shuswap',
    Stikine: 'Stikine (Census Division)',
    'Northern Rockies': 'Northern Rockies (Census Division)',
  }[boundaryName] ?? boundaryName
}

function normalizedWasteName(boundaryName) {
  return {
    'Greater Vancouver': 'Metro-Vancouver',
    'Powell River': 'qathet',
    'Skeena-Queen Charlotte': 'North Coast',
    'Comox Valley': 'Comox-Strathcona',
    Strathcona: 'Comox-Strathcona',
  }[boundaryName] ?? boundaryName
}

async function buildRegionalDistrictLayer() {
  const [wasteText, populationText] = await Promise.all([
    fetchText(SOURCES.municipalSolidWaste, 'municipal solid waste data'),
    fetchText(SOURCES.regionalDistrictPopulation, 'regional district population data'),
  ])
  const wasteRows = parseCsv(wasteText)
  const populationRows = parseCsv(populationText)
  const latestWasteYear = Math.max(...wasteRows.map((row) => number(row.Year)).filter(Number.isFinite))
  const totalPopulationRows = populationRows.filter(
    (row) => row.Type === 'Estimate' && row.Gender === 'T',
  )
  const latestPopulationYear = Math.max(
    ...totalPopulationRows.map((row) => number(row.Year)).filter(Number.isFinite),
  )
  const wasteByDistrict = new Map()
  for (const row of wasteRows) {
    const rows = wasteByDistrict.get(row.Regional_District) ?? []
    rows.push(row)
    wasteByDistrict.set(row.Regional_District, rows)
  }
  const populationByDistrict = new Map()
  for (const row of totalPopulationRows) {
    const rows = populationByDistrict.get(row['Region.Name']) ?? []
    rows.push(row)
    populationByDistrict.set(row['Region.Name'], rows)
  }
  const boundaries = JSON.parse(readFileSync(CENSUS_DIVISIONS_PATH, 'utf8'))
  if (boundaries.features.length !== 29) {
    throw new Error(`Expected 29 B.C. census-division boundaries, received ${boundaries.features.length}`)
  }
  const features = boundaries.features.map((feature) => {
    const boundaryName = feature.properties.boundaryName
    const populationName = normalizedPopulationName(boundaryName)
    const wasteName = normalizedWasteName(boundaryName)
    const districtPopulationRows = populationByDistrict.get(populationName)
    if (!districtPopulationRows) throw new Error(`No population rows for ${boundaryName}`)
    const latestPopulation = districtPopulationRows.find(
      (row) => number(row.Year) === latestPopulationYear,
    )
    const population2001 = districtPopulationRows.find((row) => number(row.Year) === 2001)
    if (!latestPopulation || !population2001) {
      throw new Error(`Missing comparison population for ${boundaryName}`)
    }
    const population = number(latestPopulation.Total)
    const baselinePopulation = number(population2001.Total)
    const populationChangePercent = ((population - baselinePopulation) / baselinePopulation) * 100
    const landAreaKm2 = number(feature.properties.LANDAREA ?? feature.properties.areaKm2)
    const populationDensity = population / landAreaKm2
    const districtWasteRows = wasteByDistrict.get(wasteName) ?? []
    const latestWaste = districtWasteRows.find((row) => number(row.Year) === latestWasteYear)
    const waste2012 = districtWasteRows.find((row) => number(row.Year) === 2012)
    const wasteRate = number(latestWaste?.Disposal_Rate_kg)
    const wasteBaselineRate = number(waste2012?.Disposal_Rate_kg)
    const wasteChangePercent =
      wasteRate !== null && wasteBaselineRate
        ? ((wasteRate - wasteBaselineRate) / wasteBaselineRate) * 100
        : null
    const wasteHistory = districtWasteRows
      .filter((row) => [1990, 2000, 2012, 2016, latestWasteYear].includes(number(row.Year)))
      .filter((row) => number(row.Disposal_Rate_kg) !== null)
      .map((row) => `${row.Year}: ${formatNumber(row.Disposal_Rate_kg)} kg/person`)
      .join('; ')
    const combinedWasteDistrict = ['Comox Valley', 'Strathcona'].includes(boundaryName)
    return {
      type: 'Feature',
      id: feature.properties.id,
      geometry: feature.geometry,
      properties: {
        id: feature.properties.id,
        boundary_name: boundaryName,
        display_name: populationName,
        land_area_km2: round(landAreaKm2, 1),
        population_2025: population,
        population_2001: baselinePopulation,
        population_change_percent: round(populationChangePercent, 1),
        population_change_band: populationChangeBand(populationChangePercent),
        population_band: populationBand(population),
        population_density: round(populationDensity, 1),
        population_density_band: populationDensityBand(populationDensity),
        population_display: `${populationName} · ${formatNumber(population)} residents`,
        population_density_display: `${populationName} · ${round(populationDensity, 1)} people / km²`,
        population_change_display: `${populationName} · ${populationChangePercent >= 0 ? '+' : ''}${round(populationChangePercent, 1)}% since 2001`,
        population_details: [
          `${latestPopulationYear} population estimate: ${formatNumber(population)}.`,
          `2001 population estimate: ${formatNumber(baselinePopulation)}.`,
          `Change since 2001: ${populationChangePercent >= 0 ? '+' : ''}${round(populationChangePercent, 1)}%.`,
        ].join('\n'),
        population_density_details: [
          `${latestPopulationYear} population density: ${round(populationDensity, 1)} people per km².`,
          `Population: ${formatNumber(population)}.`,
          `Land area: ${formatNumber(landAreaKm2)} km².`,
        ].join('\n'),
        waste_reporting_name: districtWasteRows.length ? wasteName : null,
        waste_rate_2023: wasteRate,
        waste_rate_2012: wasteBaselineRate,
        waste_change_percent: round(wasteChangePercent, 1),
        waste_rate_band: wasteBand(wasteRate),
        waste_change_band: wasteChangeBand(wasteChangePercent),
        waste_display: `${populationName} · ${wasteRate === null ? 'no reported 2023 rate' : `${formatNumber(wasteRate)} kg/person`}`,
        waste_change_display: `${populationName} · ${wasteChangePercent === null ? 'no comparable change' : `${wasteChangePercent >= 0 ? '+' : ''}${round(wasteChangePercent, 1)}% since 2012`}`,
        waste_details: wasteRate === null
          ? 'No 2023 municipal solid waste disposal rate was reported for this census division.'
          : [
              `${latestWasteYear} disposal rate: ${formatNumber(wasteRate)} kg per person.`,
              `Total disposed: ${formatNumber(latestWaste.Total_Disposed_Tonnes)} tonnes.`,
              `Reporting population: ${formatNumber(latestWaste.Population)}.`,
              combinedWasteDistrict
                ? 'Comox Valley and Strathcona report one combined waste stream; the same combined rate is shown on both boundaries.'
                : null,
              wasteHistory ? `Selected history — ${wasteHistory}.` : null,
            ].filter(Boolean).join('\n'),
        waste_change_details: wasteRate === null
          ? 'No comparable municipal solid waste series is available for this census division.'
          : [
              `${latestWasteYear} rate: ${formatNumber(wasteRate)} kg per person.`,
              `2012 rate: ${wasteBaselineRate === null ? 'not available' : `${formatNumber(wasteBaselineRate)} kg per person`}.`,
              `Change since 2012: ${wasteChangePercent === null ? 'not available' : `${wasteChangePercent >= 0 ? '+' : ''}${round(wasteChangePercent, 1)}%`}.`,
            ].join('\n'),
      },
    }
  })
  return {
    attributes: {
      schema: 'feature-attributes-v1',
      name: 'environmental_reporting_regional_district_indicators',
      metadata: {
        title: 'Environmental Reporting B.C. regional-district indicators',
        indicators: [INDICATORS.waste, INDICATORS.population],
        sources: [SOURCES.municipalSolidWaste, SOURCES.regionalDistrictPopulation],
        reusedBoundarySource: 'datascrapers/census/output/bc-da-simplified/parents/cd.geojson',
        wasteYear: latestWasteYear,
        populationYear: latestPopulationYear,
        populationBaselineYear: 2001,
        wasteBaselineYear: 2012,
        join: { boundaryProperty: 'id', attributeProperty: 'id' },
      },
      records: features.map((feature) => feature.properties).sort((left, right) =>
        left.display_name.localeCompare(right.display_name),
      ),
    },
    sourceStats: {
      wasteRows: wasteRows.length,
      populationRows: populationRows.length,
      latestWasteYear,
      latestPopulationYear,
      sourceHashes: { waste: hash(wasteText), population: hash(populationText) },
    },
  }
}

mkdirSync(OUTPUT_DIR, { recursive: true })
rmSync(join(OUTPUT_DIR, 'regional_district_environmental_indicators.geojson'), { force: true })
const [grizzly, invasive, regionalDistricts] = await Promise.all([
  buildGrizzlyLayer(),
  buildInvasiveLayer(),
  buildRegionalDistrictLayer(),
])
const outputs = [
  { ...writeGeoJson('grizzly_bear_population_units_2018.geojson', grizzly.layer), publicPath: PUBLIC_PATHS.grizzly },
  { ...writeGeoJson('aquatic_invasive_species_by_edu.geojson', invasive.layer), publicPath: PUBLIC_PATHS.invasive },
  {
    ...writeJson(
      'regional_district_environmental_indicators.json',
      regionalDistricts.attributes,
      regionalDistricts.attributes.records.length,
    ),
    publicPath: PUBLIC_PATHS.regionalDistricts,
  },
]
const manifest = {
  generatedAt: new Date().toISOString(),
  indicators: INDICATORS,
  sources: SOURCES,
  outputs,
  sourceStats: {
    grizzly: grizzly.sourceStats,
    invasive: invasive.sourceStats,
    regionalDistricts: regionalDistricts.sourceStats,
  },
}
writeFileSync(join(OUTPUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(JSON.stringify(manifest, null, 2))
