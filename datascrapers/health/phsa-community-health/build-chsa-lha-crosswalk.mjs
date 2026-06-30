#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output')
const PGMAPS_ROOT = process.env.PGMAPS_ROOT ? path.resolve(process.env.PGMAPS_ROOT) : path.resolve(SCRIPT_DIR, '..', '..', '..', '..')
const CHSA_BOUNDARIES = path.join(PGMAPS_ROOT, 'public/data/boundaries/BCMoH/community_health_service_areas.json')

function csvEscape(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true })
  const collection = JSON.parse(await readFile(CHSA_BOUNDARIES, 'utf8'))
  const records = collection.features.map((feature) => {
    const properties = feature.properties ?? {}
    return {
      chsa_code: String(properties.CMNTY_HLTH_SERV_AREA_CODE ?? ''),
      chsa_name: String(properties.CMNTY_HLTH_SERV_AREA_NAME ?? ''),
      chsa_population_census: Number(properties.CHSA_POPULATION_CENSUS) || null,
      lha_code: String(properties.LOCAL_HLTH_AREA_CODE ?? ''),
      lha_name: String(properties.LOCAL_HLTH_AREA_NAME ?? ''),
      hsda_code: String(properties.HLTH_SERVICE_DLVR_AREA_CODE ?? ''),
      hsda_name: String(properties.HLTH_SERVICE_DLVR_AREA_NAME ?? ''),
      health_authority_code: String(properties.HLTH_AUTHORITY_CODE ?? ''),
      health_authority_name: String(properties.HLTH_AUTHORITY_NAME ?? ''),
    }
  })

  const lhaPopulation = new Map()
  for (const record of records) {
    if (!record.lha_code || !Number.isFinite(record.chsa_population_census)) continue
    lhaPopulation.set(record.lha_code, (lhaPopulation.get(record.lha_code) ?? 0) + record.chsa_population_census)
  }

  const weightedRecords = records.map((record) => ({
    ...record,
    lha_population_from_chsa: lhaPopulation.get(record.lha_code) ?? null,
    chsa_population_weight_in_lha:
      Number.isFinite(record.chsa_population_census) && lhaPopulation.get(record.lha_code)
        ? record.chsa_population_census / lhaPopulation.get(record.lha_code)
        : null,
  }))

  const columns = [
    'chsa_code',
    'chsa_name',
    'chsa_population_census',
    'lha_code',
    'lha_name',
    'lha_population_from_chsa',
    'chsa_population_weight_in_lha',
    'hsda_code',
    'hsda_name',
    'health_authority_code',
    'health_authority_name',
  ]
  const csv = [
    columns.join(','),
    ...weightedRecords.map((record) => columns.map((column) => csvEscape(record[column])).join(',')),
  ].join('\n')

  await writeFile(path.join(OUTPUT_DIR, 'chsa-lha-crosswalk.json'), `${JSON.stringify(weightedRecords, null, 2)}\n`)
  await writeFile(path.join(OUTPUT_DIR, 'chsa-lha-crosswalk.csv'), `${csv}\n`)

  console.log(`PHSA: wrote ${weightedRecords.length} CHSA-to-LHA crosswalk rows`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
