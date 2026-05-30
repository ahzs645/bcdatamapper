import { pathToFileURL } from 'node:url'
import { asNumber, countBy, fetchText, OUTPUT_ROOT, parseCsv, PG_CITY, pointFeature, slug, writeJson } from './lib/shared.mjs'

export const EDUCATION_SOURCES = {
  k12: {
    label: 'BC Schools K-12 with Francophone Indicators',
    url: 'https://catalogue.data.gov.bc.ca/dataset/95da1091-7e8c-4aa6-9c1b-5ab159ea7b42/resource/5832eff2-3380-435e-911b-5ada41c1d30b/download/bc_k12_schools_2026_databc.csv',
  },
  childcare: {
    label: 'BC Child Care Map Data',
    url: 'https://catalogue.data.gov.bc.ca/dataset/4cc207cc-ff03-44f8-8c5f-415af5224646/resource/9a9f14e1-03ea-4a11-936a-6e77b15eeb39/download/childcare_locations.csv',
  },
  postSecondary: {
    label: 'Locations of B.C. Post-Secondary Institutions',
    url: 'https://catalogue.data.gov.bc.ca/dataset/81558d54-1f96-46c2-94fe-56d26f69c4f5/resource/8e4e2a87-2d1d-4931-828e-6327b49f310e/download/loc1-locations-of-bc-public-private-and-theological-post-secondary-institutions.csv',
  },
}

function buildEducationFeature(source, row, index) {
  if (source === 'k12') {
    const latitude = asNumber(row.LATITUDE)
    const longitude = asNumber(row.LONGITUDE)
    if (row.PHYSICAL_ADDRESS_CITY?.trim().toLowerCase() !== PG_CITY || latitude == null || longitude == null) return null
    return pointFeature({
      id: `k12-${row.MINCODE || index}`,
      source: 'bc_k12_schools',
      name: row.SCHOOL_NAME,
      category: 'school_k12',
      latitude,
      longitude,
      properties: {
        educationFacilityType: row.FACILITY_TYPE,
        educationLevel: row.SCHOOL_EDUCATION_LEVEL,
        publicOrIndependent: row.PUBLIC_OR_INDEPENDENT,
        districtNumber: row.DISTRICT_NUMBER,
        districtName: row.DISTRICT_NAME,
        address: [row.STREET_ADDRESS, row.PHYSICAL_ADDRESS_CITY, row.ADDRESS_POSTAL_CODE].filter(Boolean).join(', '),
        designCapacityTotal: asNumber(row.DESIGN_CAPACITY_TOTAL),
        hasCoreFrench: row.HAS_CORE_FRENCH,
        hasEarlyFrenchImmersion: row.HAS_EARLY_FRENCH_IMMERSION,
        hasLateFrenchImmersion: row.HAS_LATE_FRENCH_IMMERSION,
        hasFrancophoneProgram: row.HAS_PROG_FRANCOPHONE,
      },
    })
  }

  if (source === 'childcare') {
    const latitude = asNumber(row.LATITUDE)
    const longitude = asNumber(row.LONGITUDE)
    if (row.CITY?.trim().toLowerCase() !== PG_CITY || latitude == null || longitude == null) return null
    return pointFeature({
      id: `childcare-${row.FAC_PARTY_ID || index}`,
      source: 'bc_childcare_map',
      name: row.NAME,
      category: 'child_care',
      latitude,
      longitude,
      properties: {
        serviceType: row.SERVICE_TYPE_CD,
        address: [row.ADDRESS_1, row.ADDRESS_2, row.CITY, row.POSTAL_CODE].filter(Boolean).join(', '),
        phone: row.PHONE,
        website: row.WEBSITE,
        weekdayOperation: row.OP_WEEKDAY_YN,
        weekendOperation: row.OP_WEEKEND_YN,
        servesUnder36Months: row.SRVC_UNDER36_YN,
        serves30MonthsTo5Years: row.SRVC_30MOS_5YRS_YN,
        servesPreschool: row.SRVC_LICPRE_YN,
        servesKindergartenOutOfSchool: row.SRVC_OOS_KINDER_YN,
        servesGrade1To12OutOfSchool: row.SRVC_OOS_GR1_AGE12_YN,
        providesMeals: row.PROVIDE_CD_MEALS,
      },
    })
  }

  const latitude = asNumber(row.Latitude)
  const longitude = asNumber(row.Longitude)
  if (row.City?.trim().toLowerCase() !== PG_CITY || latitude == null || longitude == null) return null
  return pointFeature({
    id: `post-secondary-${slug(row.Institution)}-${index}`,
    source: 'bc_post_secondary_locations',
    name: row.Institution,
    category: 'post_secondary',
    latitude,
    longitude,
    properties: {
      acronym: row.Acronym,
      campusLocation: row.Location,
      institutionType: row['Institution Type'],
      economicDevelopmentRegion: row['Economic Development Region'],
      address: [row.Address, row.City].filter(Boolean).join(', '),
      locationDescription: row['Location Description'],
    },
  })
}

export async function buildEducationFacilities() {
  const features = []
  const sourceStats = {}

  for (const [source, config] of Object.entries(EDUCATION_SOURCES)) {
    const rows = parseCsv(await fetchText(config.url))
    const sourceFeatures = rows.map((row, index) => buildEducationFeature(source, row, index)).filter(Boolean)
    features.push(...sourceFeatures)
    sourceStats[source] = {
      label: config.label,
      url: config.url,
      totalRows: rows.length,
      princeGeorgeFeatures: sourceFeatures.length,
    }
  }

  return {
    collection: {
      type: 'FeatureCollection',
      features,
    },
    sourceStats,
  }
}

export async function syncEducationFacilities() {
  const education = await buildEducationFacilities()
  await writeJson(`${OUTPUT_ROOT}/education_facilities.geojson`, education.collection)
  await writeJson(`${OUTPUT_ROOT}/education_manifest.json`, {
    generatedAt: new Date().toISOString(),
    coverage: 'Prince George, BC',
    outputs: {
      educationFacilities: '/data/healthyplan-pg/education_facilities.geojson',
    },
    education: {
      ...education.sourceStats,
      categoryCounts: countBy(education.collection.features, (feature) => feature.properties.category),
      featureCount: education.collection.features.length,
    },
    licenses: [
      {
        source: 'BC Data Catalogue education datasets',
        license: 'Open Government Licence - British Columbia',
      },
    ],
  })
  console.log(`Education facilities: ${education.collection.features.length}`)
  return education
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncEducationFacilities().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
