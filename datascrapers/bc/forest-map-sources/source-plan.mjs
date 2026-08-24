const BCGW_BASE = 'https://openmaps.gov.bc.ca/geo/pub'

const plans = {
  vri: {
    id: 'vri_forest_data',
    outputDir: 'public/data/forest/vri',
    outputFile: 'vri_forest_data.geojson',
    source: {
      name: 'VRI - 2025 - Forest Vegetation Composite Rank 1 Layer (R1)',
      catalogueUrl: 'https://catalogue.data.gov.bc.ca/dataset/vri-2025-forest-vegetation-composite-rank-1-layer-r1-',
      bulkDownloadUrl:
        'https://pub.data.gov.bc.ca/datasets/02dba161-fdb7-48ae-a4bb-bd6ef017c36d/current/VEG_COMP_LYR_R1_POLY_2025.gdb.zip',
      wfsTypeName: 'WHSE_FOREST_VEGETATION.VEG_COMP_LYR_R1_POLY',
    },
    shouldUseDirectSource: true,
    implementationNote:
      'Prefer the FGDB ZIP for full-province rebuilds; use BCGW WFS only for bounded/clipped extracts. This is current VRI 2025, not necessarily the exact older BC Forest Map snapshot.',
    bcForestMapProcessing:
      'Use projected age/height fields for old-growth highlighting; preserve PROJ_AGE_1, PROJ_AGE_2, PROJ_HEIGHT_1, PROJ_HEIGHT_2, species code fields, biomass fields, and harvest date fields needed by map UI.',
  },
  resultsOpenings: {
    id: 'planned_logging_results_openings',
    outputDir: 'public/data/forest/planned-logging',
    outputFile: 'results_openings_planned.geojson',
    source: {
      name: 'RESULTS - Openings svw',
      catalogueUrl: 'https://catalogue.data.gov.bc.ca/dataset/results-openings-svw',
      wfsTypeName: 'WHSE_FOREST_VEGETATION.RSLT_OPENING_SVW',
    },
    shouldUseDirectSource: true,
    implementationNote:
      'Use BCGW WFS with CQL_FILTER and/or a bounded extract. Do not use the BC Forest Map Mapbox tileset as the source of record.',
    cqlFilterTemplate:
      "APPROVE_DATE AFTER {one_year_ago} AND DISTURBANCE_END_DATE IS NULL AND FEATURE_AREA > 0 AND (DENUDATION_COUNT IS NULL OR DENUDATION_COUNT = 0) AND (PLANTING_COUNT IS NULL OR PLANTING_COUNT = 0)",
  },
  ftaCutblocks: {
    id: 'planned_logging_fta_cutblocks_next_5_years',
    outputDir: 'public/data/forest/planned-logging',
    outputFile: 'fta_cutblocks_next_5_years.geojson',
    source: {
      name: 'Forest Tenure Cutblock Polygons (FTA 4.0)',
      catalogueUrl: 'https://catalogue.data.gov.bc.ca/dataset/forest-tenure-cutblock-polygons-fta-4-0',
      wfsTypeName: 'WHSE_FOREST_TENURE.FTEN_CUT_BLOCK_POLY_SVW',
    },
    shouldUseDirectSource: true,
    implementationNote:
      'Use BCGW WFS. BC Forest Map describes this as planned harvest dates from one year in the past through five years in the future.',
    cqlFilterTemplate:
      "PLANNED_HARVEST_DATE AFTER {one_year_ago} AND PLANNED_HARVEST_DATE BEFORE {five_years_from_now}",
  },
  speciesAtRisk: {
    id: 'species_at_risk_habitat',
    outputDir: 'public/data/forest/species-at-risk',
    outputFile: 'species_at_risk_habitat.geojson',
    source: {
      name: 'Species and Ecosystems at Risk - Publicly Available Occurrences - CDC',
      catalogueUrl:
        'https://catalogue.data.gov.bc.ca/dataset/species-and-ecosystems-at-risk-publicly-available-occurrences-cdc',
      wfsTypeName: 'WHSE_TERRESTRIAL_ECOLOGY.BIOT_OCCR_NON_SENS_AREA_SVW',
      arcgisItemUrl: 'https://governmentofbc.maps.arcgis.com/home/item.html?id=5253c812c9584c89ba60944adb4e650b',
    },
    shouldUseDirectSource: true,
    implementationNote:
      'Start with the BC CDC WFS layer. The BC Forest Map layer also combined federal SARA data; add a second source once the federal BC spatial download/API is pinned.',
    cqlFilterTemplate: "CHMethod <> 'Modelling, Land Classification'",
  },
  inaturalistSpeciesAtRisk: {
    id: 'inaturalist_species_at_risk',
    outputDir: 'datascrapers/bc/forest-map-sources/output/species-at-risk',
    outputFile: 'inaturalist_species_at_risk.geojson',
    source: {
      name: 'iNaturalist observations API',
      apiUrl: 'https://api.inaturalist.org/v1/observations',
    },
    shouldUseDirectSource: true,
    implementationNote:
      'Use the public API directly, then persist a dated snapshot. Results are live and may not match the old BC Forest Map Mapbox snapshot.',
    query: {
      quality_grade: 'research',
      acc_below: '50',
      threatened: 'true',
      taxon_geoprivacy: 'open',
      per_page: '200',
      hrank: 'genus',
    },
  },
  bigTreeRegistry: {
    id: 'bc_bigtree_registry',
    outputDir: 'datascrapers/bc/forest-map-sources/output',
    outputFile: 'bc_bigtree_registry.geojson',
    source: {
      name: 'BC BigTree Registry reports',
      reportsUrl: 'https://bigtrees.forestry.ubc.ca/registry-reports/',
      registryUrl: 'https://bigtrees.forestry.ubc.ca/bc-bigtree-registry/',
    },
    shouldUseDirectSource: true,
    implementationNote:
      'Use the UBC reports page xlsx/csv export as the authoritative source. The checked-in deployable snapshot is normalized from the supplied BC Forest Map GeoJSON because UBC bot protection can block unattended CSV downloads; preserve that fallback provenance in metadata.',
  },
}

export function getWfsUrl(typeName, { cqlFilter, bbox, geomField = 'SHAPE', maxFeatures = '50000' } = {}) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '1.0.0',
    request: 'GetFeature',
    typeName: `pub:${typeName}`,
    outputFormat: 'json',
    srsName: 'EPSG:4326',
    maxFeatures,
  })

  const clauses = []
  if (cqlFilter) clauses.push(`(${cqlFilter})`)
  if (bbox) clauses.push(`BBOX(${geomField},${bbox.join(',')},'EPSG:4326')`)
  if (clauses.length) params.set('CQL_FILTER', clauses.join(' AND '))

  return `${BCGW_BASE}/${typeName}/ows?${params.toString()}`
}

export function getPlan(planId) {
  const plan = plans[planId]
  if (!plan) {
    throw new Error(`Unknown BC Forest Map source plan: ${planId}`)
  }
  return plan
}

export function printPlan(planId) {
  const plan = getPlan(planId)
  const source = plan.source
  const runnableHints = {}
  if (source.wfsTypeName) {
    runnableHints.exampleWfsUrl = getWfsUrl(source.wfsTypeName, {
      cqlFilter: plan.cqlFilterTemplate?.replaceAll('{one_year_ago}', 'YYYY-MM-DD').replaceAll('{five_years_from_now}', 'YYYY-MM-DD'),
    })
  }
  if (source.apiUrl && plan.query) {
    const url = new URL(source.apiUrl)
    for (const [key, value] of Object.entries(plan.query)) url.searchParams.set(key, value)
    runnableHints.exampleApiUrl = url.toString()
  }

  console.log(
    JSON.stringify(
      {
        ...plan,
        runnableHints,
        guardrail:
          'Do not download in this source-plan script. Implement a separate sync script after output schema, clipping, and snapshot policy are reviewed.',
      },
      null,
      2,
    ),
  )
}
