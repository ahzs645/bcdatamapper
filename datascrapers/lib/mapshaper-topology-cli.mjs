#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import {
  simplifyPolygonTopology,
  TOPOLOGY_PROFILES,
} from './mapshaper-topology.mjs'

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`)
    const equals = argument.indexOf('=')
    const key = argument.slice(2, equals >= 0 ? equals : undefined)
    const value = equals >= 0 ? argument.slice(equals + 1) : argv[++index]
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for --${key}`)
    options[key] = value
  }
  return options
}

function required(options, key) {
  if (!options[key]) throw new Error(`Missing required --${key}`)
  return options[key]
}

const args = parseArgs(process.argv.slice(2))
const inputPath = required(args, 'input')
const outputPath = required(args, 'output')
const toleranceMetres = Number(required(args, 'tolerance-metres'))
const coordinatePrecision = Number(args['coordinate-precision'] ?? 6)
const topologyProfile = args['topology-profile'] ?? TOPOLOGY_PROFILES.PARTITION

const input = JSON.parse(readFileSync(inputPath, 'utf8'))
const output = simplifyPolygonTopology(input, {
  toleranceMetres,
  sourceCrs: args['source-crs'] ?? 'EPSG:4326',
  workingCrs: args['working-crs'] ?? 'EPSG:3005',
  outputCrs: args['output-crs'] ?? 'EPSG:4326',
  coordinatePrecision,
  topologyProfile,
  tempPrefix: args['temp-prefix'] ?? 'mapshaper-topology-cli-',
})

writeFileSync(outputPath, `${JSON.stringify(output)}\n`)
