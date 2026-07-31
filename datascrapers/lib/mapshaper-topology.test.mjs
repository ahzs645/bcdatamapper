import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  simplifyPolygonTopology,
  TOPOLOGY_PROFILES,
} from './mapshaper-topology.mjs'

function canonicalEdge(a, b) {
  const aKey = `${a[0]},${a[1]}`
  const bKey = `${b[0]},${b[1]}`
  return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`
}

function polygonEdges(feature) {
  return feature.geometry.coordinates[0].slice(0, -1).map((point, index) => (
    canonicalEdge(point, feature.geometry.coordinates[0][index + 1])
  ))
}

test('simplifies adjacent polygons with exact shared output edges', () => {
  const shared = [
    [-123, 53],
    [-122.999, 53.002],
    [-123.001, 53.004],
    [-123, 53.006],
    [-123, 53.01],
  ]
  const collection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: 'west' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[-123.02, 53], ...shared, [-123.02, 53.01], [-123.02, 53]]],
        },
      },
      {
        type: 'Feature',
        properties: { id: 'east' },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            shared[0],
            [-122.98, 53],
            [-122.98, 53.01],
            shared[4],
            shared[3],
            shared[2],
            shared[1],
            shared[0],
          ]],
        },
      },
    ],
  }

  const output = simplifyPolygonTopology(collection, {
    toleranceMetres: 250,
    coordinatePrecision: 6,
    topologyProfile: TOPOLOGY_PROFILES.PARTITION,
    tempPrefix: 'mapshaper-topology-test-',
  })

  assert.equal(output.features.length, 2)
  assert.equal(output.metadata.topologyProfile, 'partition')
  assert.equal(output.metadata.cleaningApplied, true)
  const [westEdges, eastEdges] = output.features.map((feature) => new Set(polygonEdges(feature)))
  assert.ok([...westEdges].some((edge) => eastEdges.has(edge)), 'expected an exact shared edge')
})

test('preserves intentional overlaps in overlap mode', () => {
  const collection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { id: 'west' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[-123.02, 53], [-122.99, 53], [-122.99, 53.02], [-123.02, 53.02], [-123.02, 53]]],
        },
      },
      {
        type: 'Feature',
        properties: { id: 'east' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[-123, 53], [-122.98, 53], [-122.98, 53.02], [-123, 53.02], [-123, 53]]],
        },
      },
      {
        type: 'Feature',
        properties: { id: 'empty-source-shell' },
        geometry: { type: 'Polygon', coordinates: [] },
      },
    ],
  }

  const output = simplifyPolygonTopology(collection, {
    toleranceMetres: 100,
    coordinatePrecision: 6,
    topologyProfile: TOPOLOGY_PROFILES.OVERLAP,
    tempPrefix: 'mapshaper-overlap-test-',
  })

  const westEast = Math.max(...output.features[0].geometry.coordinates[0].map(([x]) => x))
  const eastWest = Math.min(...output.features[1].geometry.coordinates[0].map(([x]) => x))
  assert.ok(westEast > eastWest, 'expected the source overlap to remain')
  assert.equal(output.metadata.topologyProfile, 'overlap')
  assert.equal(output.metadata.cleaningApplied, false)
  assert.equal(output.metadata.intentionalOverlapPreserved, true)
  assert.equal(output.metadata.sourceFeatureCount, 3)
  assert.equal(output.metadata.droppedInvalidGeometryFeatureCount, 1)
  assert.equal(output.metadata.outputFeatureCount, 2)
})

test('file CLI exposes the same pipeline to non-JavaScript builders', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mapshaper-topology-cli-test-'))
  const inputPath = join(tempDir, 'input.geojson')
  const outputPath = join(tempDir, 'output.geojson')
  const collection = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { id: 'example' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-123.01, 53], [-123, 53], [-123, 53.01], [-123.01, 53.01], [-123.01, 53]]],
      },
    }],
  }

  try {
    writeFileSync(inputPath, JSON.stringify(collection))
    execFileSync(process.execPath, [
      new URL('./mapshaper-topology-cli.mjs', import.meta.url).pathname,
      '--input', inputPath,
      '--output', outputPath,
      '--tolerance-metres', '50',
      '--coordinate-precision', '6',
      '--topology-profile', TOPOLOGY_PROFILES.OVERLAP,
    ], { stdio: 'inherit' })
    const output = JSON.parse(readFileSync(outputPath, 'utf8'))
    assert.equal(output.features.length, 1)
    assert.equal(output.metadata.topologyProfile, 'overlap')
    assert.equal(output.metadata.mapshaperVersion, '0.6.113')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
