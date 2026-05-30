import { countBy, OUTPUT_ROOT, writeJson } from './lib/shared.mjs'
import { syncCityPgBusiness } from './sync-citypg-business.mjs'
import { syncEducationFacilities } from './sync-education.mjs'

async function main() {
  const education = await syncEducationFacilities()
  const business = await syncCityPgBusiness()

  await writeJson(`${OUTPUT_ROOT}/manifest.json`, {
    generatedAt: new Date().toISOString(),
    coverage: 'Prince George, BC',
    outputs: {
      educationFacilities: '/data/healthyplan-pg/education_facilities.geojson',
      businessPois: '/data/healthyplan-pg/business_pois.geojson',
      businessLicencesAll: '/data/healthyplan-pg/business_licences_all.json',
      businessCandidates: '/data/healthyplan-pg/business_candidates.json',
    },
    education: {
      ...education.sourceStats,
      categoryCounts: countBy(education.collection.features, (feature) => feature.properties.category),
      featureCount: education.collection.features.length,
    },
    businessPois: {
      ...business.sourceStats,
      featureCount: business.collection.features.length,
      categoryCounts: countBy(business.collection.features, (feature) => feature.properties.category),
      healthyFoodOutletCount: business.collection.features.filter((feature) => feature.properties.healthyFoodOutlet)
        .length,
      retailServiceCount: business.collection.features.filter((feature) => feature.properties.retailService).length,
      note: 'OSM supplies point geometry/class tags. CityPG business licences supply authoritative local inventory and are bridged by normalized name where possible. All CityPG rows are preserved in business_licences_all.json; likely HealthyPlan-relevant rows are also copied to business_candidates.json for geocoding/audit.',
    },
    licenses: [
      {
        source: 'BC Data Catalogue education datasets',
        license: 'Open Government Licence - British Columbia',
      },
      {
        source: 'City of Prince George Business License',
        license: 'City of Prince George Open Government Licence / source item terms',
      },
      {
        source: 'OpenStreetMap Overpass',
        license: 'Open Database Licence; attribution and derivative-database handling required',
      },
    ],
  })

  console.log(`Manifest: ${OUTPUT_ROOT}/manifest.json`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
