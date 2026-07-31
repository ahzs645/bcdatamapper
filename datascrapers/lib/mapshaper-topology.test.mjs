import assert from 'node:assert/strict'
import test from 'node:test'
import { simplifySharedPolygonTopology } from './mapshaper-topology.mjs'

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

  const output = simplifySharedPolygonTopology(collection, {
    toleranceMetres: 250,
    coordinatePrecision: 6,
    tempPrefix: 'mapshaper-topology-test-',
  })

  assert.equal(output.features.length, 2)
  const [westEdges, eastEdges] = output.features.map((feature) => new Set(polygonEdges(feature)))
  assert.ok([...westEdges].some((edge) => eastEdges.has(edge)), 'expected an exact shared edge')
})
