import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import {
  buildHospitalCollection,
  buildWatershedCollection,
  EXPECTED_HOSPITALS,
  HOSPITAL_OUTPUT_PATH,
  HOSPITAL_SOURCE_PATH,
  WATERSHED_OUTPUT_PATH,
} from './build-project-layers.mjs'

const hospital = (name, coordinates, extra = {}) => ({
  type: 'Feature',
  properties: {
    canonical_name: name,
    place_type: 'hospital',
    source_url: 'https://www.northernhealth.ca/locations/hospitals/example',
    source_label: 'Northern Health',
    locality: 'Example',
    address: '1 Example St',
    verification_status: 'unverified',
    ...extra,
  },
  geometry: { type: 'Point', coordinates },
})

test('the committed watersheds match a rebuild from the committed stream-order shards', () => {
  assert.equal(readFileSync(WATERSHED_OUTPUT_PATH, 'utf8'), `${JSON.stringify(buildWatershedCollection())}\n`)
})

test('keeps one hospital per point and prefers the verified record', () => {
  const collection = buildHospitalCollection({
    features: [
      hospital('Unverified Duplicate', [-122.75, 53.91]),
      hospital('University Hospital of Northern BC', [-122.75, 53.91], { verification_status: 'verified' }),
      hospital('Another Hospital', [-128.6, 54.5]),
    ],
  })
  assert.deepEqual(
    collection.features.map((feature) => feature.properties.name),
    ['Another Hospital', 'University Hospital of Northern BC'],
  )
  assert.equal(collection.features[1].properties.id, 'university-hospital-of-northern-bc')
  assert.equal(collection.features[1].properties.healthAuthority, 'Northern Health')
  assert.equal(collection.metadata.features, 2)
})

test('leaves out clinics, other health authorities and records without a point', () => {
  const collection = buildHospitalCollection({
    features: [
      hospital('A Clinic', [-122.7, 53.9], { place_type: 'clinic' }),
      hospital('Interior Hospital', [-119.4, 49.8], { source_url: 'https://www.interiorhealth.ca/x' }),
      { ...hospital('No Point', [0, 0]), geometry: null },
    ],
  })
  assert.equal(collection.features.length, 0)
})

test('the committed hospitals hold every Northern Health hospital once', () => {
  const committed = JSON.parse(readFileSync(HOSPITAL_OUTPUT_PATH, 'utf8'))
  assert.equal(committed.features.length, EXPECTED_HOSPITALS)
  assert.equal(new Set(committed.features.map((feature) => feature.properties.id)).size, EXPECTED_HOSPITALS)
})

// The registry lives in the nested healthdata submodule, which not every checkout initializes.
test(
  'the committed hospitals match a rebuild from the health place registry',
  { skip: !existsSync(HOSPITAL_SOURCE_PATH) && 'data-sources/healthdata is not checked out' },
  () => {
    const rebuilt = buildHospitalCollection(JSON.parse(readFileSync(HOSPITAL_SOURCE_PATH, 'utf8')))
    assert.equal(readFileSync(HOSPITAL_OUTPUT_PATH, 'utf8'), `${JSON.stringify(rebuilt)}\n`)
  },
)
