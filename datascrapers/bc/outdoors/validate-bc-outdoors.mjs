#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { area, bbox, intersect } from '@turf/turf'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = join(SCRIPT_DIR, 'output')

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function boxesOverlap(left, right) {
  return left[0] < right[2] && left[2] > right[0] && left[1] < right[3] && left[3] > right[1]
}

function validateFeatureCollection(collection, layer) {
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
    throw new Error(`${layer.id} is not a GeoJSON FeatureCollection`)
  }
  if (collection.features.length !== layer.featureCount) {
    throw new Error(`${layer.id} manifest says ${layer.featureCount} features but file contains ${collection.features.length}`)
  }

  const ids = collection.features.map((feature) => String(feature.id ?? feature.properties?.boundaryCode ?? ''))
  if (ids.some((id) => !id)) throw new Error(`${layer.id} contains a feature without an identifier`)
  if (new Set(ids).size !== ids.length) throw new Error(`${layer.id} contains duplicate identifiers`)
  if (!ids.includes('7-42')) throw new Error(`${layer.id} does not contain the planning specimen unit 7-42`)

  const entries = collection.features.map((feature) => ({ feature, bbox: bbox(feature) }))
  const overlaps = []
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex]
      const right = entries[rightIndex]
      if (!boxesOverlap(left.bbox, right.bbox)) continue
      let overlap
      try {
        overlap = intersect(left.feature, right.feature)
      } catch (error) {
        throw new Error(`Could not validate overlap between ${ids[leftIndex]} and ${ids[rightIndex]}: ${error.message}`)
      }
      if (!overlap) continue
      const overlapAreaSqM = area(overlap)
      if (overlapAreaSqM > 1) {
        overlaps.push({ left: ids[leftIndex], right: ids[rightIndex], overlapAreaSqM })
      }
    }
  }
  if (overlaps.length > 0) {
    throw new Error(`${layer.id} contains ${overlaps.length} polygon overlaps; first: ${JSON.stringify(overlaps[0])}`)
  }

  const maximumAreaDrift = Math.max(...collection.features.map(
    (feature) => Number(feature.properties?.areaDriftPercent ?? 0),
  ))
  if (maximumAreaDrift > 1) throw new Error(`${layer.id} maximum area drift is ${maximumAreaDrift}%`)

  return {
    featureCount: collection.features.length,
    polygonOverlapCount: overlaps.length,
    maximumAreaDriftPercent: maximumAreaDrift,
  }
}

const manifest = JSON.parse(await readFile(join(OUTPUT_DIR, 'manifest.json'), 'utf8'))
if (!manifest.complete) throw new Error('BC outdoors manifest is not complete')

const results = []
for (const layer of manifest.layers) {
  const compressed = await readFile(join(OUTPUT_DIR, layer.path))
  if (compressed.byteLength !== layer.bytes) {
    throw new Error(`${layer.id} byte count changed from ${layer.bytes} to ${compressed.byteLength}`)
  }
  const raw = gunzipSync(compressed)
  if (raw.byteLength !== layer.rawBytes) {
    throw new Error(`${layer.id} raw byte count changed from ${layer.rawBytes} to ${raw.byteLength}`)
  }
  const collection = JSON.parse(raw.toString('utf8'))
  results.push({
    id: layer.id,
    bytes: compressed.byteLength,
    rawBytes: raw.byteLength,
    sha256: sha256(compressed),
    ...validateFeatureCollection(collection, layer),
  })
}

console.log(JSON.stringify({ valid: true, layers: results }, null, 2))
