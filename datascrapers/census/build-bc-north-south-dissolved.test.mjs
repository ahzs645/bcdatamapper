import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { BC_NORTH_SOUTH_DISSOLVED_PATH } from './build-bc-north-south-dissolved.mjs'

test('the committed dissolve holds one North and one South feature with only the display fields', () => {
  const collection = JSON.parse(readFileSync(BC_NORTH_SOUTH_DISSOLVED_PATH, 'utf8'))
  assert.deepEqual(
    collection.features.map((feature) => feature.properties).sort((a, b) => a.label.localeCompare(b.label)),
    [
      { north_south: 'North', label: 'Statistical North' },
      { north_south: 'South', label: 'Statistical South' },
    ],
  )
  for (const feature of collection.features) {
    assert.equal(feature.geometry.type, 'MultiPolygon')
    assert.ok(feature.geometry.coordinates.length > 0)
  }
})
