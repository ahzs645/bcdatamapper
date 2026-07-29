import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyCsdNorthSouth, NORTHERN_CENSUS_DIVISION_UIDS } from './north-south-classification.mjs'

test('contains all 43 northern provincial census divisions', () => {
  assert.equal(NORTHERN_CENSUS_DIVISION_UIDS.size, 43)
})

test('classifies Prince George through Fraser-Fort George as North', () => {
  assert.equal(classifyCsdNorthSouth('5953023'), 'North')
})

test('classifies every territorial CSD as North', () => {
  assert.equal(classifyCsdNorthSouth('6001009'), 'North')
  assert.equal(classifyCsdNorthSouth('6101017'), 'North')
  assert.equal(classifyCsdNorthSouth('6204003'), 'North')
})

test('classifies CSDs outside northern CDs as South', () => {
  assert.equal(classifyCsdNorthSouth('5915022'), 'South')
  assert.equal(classifyCsdNorthSouth('3520005'), 'South')
})

test('rejects malformed CSD identifiers', () => {
  assert.throws(() => classifyCsdNorthSouth('5953'), /seven-digit CSDUID/)
})
