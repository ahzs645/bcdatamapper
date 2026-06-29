#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDbf } from 'shpjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const censusDir = __dirname
const bcdatamapperRoot = path.resolve(censusDir, '..', '..')

const DEFAULT_SOURCE_ROOT = '/Users/ahmadjalil/Downloads/New Folder With Items 5'
const DEFAULT_DB_DATA_ZIP = path.join(DEFAULT_SOURCE_ROOT, 'DB Data-20260629T213631Z-3-001.zip')
const DEFAULT_CROSSWALK_ENTRY = 'DB Data/Crosswalk/DB_CHSA_Crosswalk_2021.xlsx'
const DEFAULT_RAW_ARCHIVE = path.join(
  DEFAULT_SOURCE_ROOT,
  'BCCDC/Angela Data and Script/BCCDC raw archive',
)
const DEFAULT_BCMOH_INDEX = path.join(
  bcdatamapperRoot,
  'datascrapers/bc/boundaries/output/BCMoH/index.json',
)
const DEFAULT_OUTPUT = path.join(censusDir, 'output')
const CROSSWALK_SHEET_NAME = 'DB-CHSA2021'

function parseArgs(argv) {
  const options = {
    dbDataZip: DEFAULT_DB_DATA_ZIP,
    crosswalkXlsx: '',
    crosswalkEntry: DEFAULT_CROSSWALK_ENTRY,
    rawArchive: DEFAULT_RAW_ARCHIVE,
    bcmohIndex: DEFAULT_BCMOH_INDEX,
    output: DEFAULT_OUTPUT,
    generatedAt: new Date().toISOString(),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const [key, inlineValue] = arg.split('=')
    const nextValue = inlineValue ?? argv[index + 1]
    const consumeNext = inlineValue == null

    if (key === '--db-data-zip') {
      options.dbDataZip = path.resolve(nextValue)
      if (consumeNext) index += 1
    } else if (key === '--crosswalk-xlsx') {
      options.crosswalkXlsx = path.resolve(nextValue)
      if (consumeNext) index += 1
    } else if (key === '--crosswalk-entry') {
      options.crosswalkEntry = String(nextValue)
      if (consumeNext) index += 1
    } else if (key === '--raw-archive') {
      options.rawArchive = path.resolve(nextValue)
      if (consumeNext) index += 1
    } else if (key === '--bcmoh-index') {
      options.bcmohIndex = path.resolve(nextValue)
      if (consumeNext) index += 1
    } else if (key === '--output') {
      options.output = path.resolve(nextValue)
      if (consumeNext) index += 1
    } else if (key === '--generated-at') {
      options.generatedAt = String(nextValue)
      if (consumeNext) index += 1
    } else if (key === '--help') {
      console.log(`Usage: node datascrapers/census/build-bc-db-crosswalk.mjs [options]

Options:
  --db-data-zip <zip>        Archive containing ${DEFAULT_CROSSWALK_ENTRY}
  --crosswalk-xlsx <xlsx>    Direct path to DB_CHSA_Crosswalk_2021.xlsx; bypasses --db-data-zip
  --crosswalk-entry <path>   Entry path inside --db-data-zip (default: ${DEFAULT_CROSSWALK_ENTRY})
  --raw-archive <dir>        BCCDC raw archive containing db21.dbf and bc_db_pop_dwell_2021.dbf
  --bcmoh-index <json>       BCMoH boundary index JSON with CHSA/LHA/HSDA/HA names
  --output <dir>             Directory for bc_db_population_chsa_crosswalk.json and bc_db_chsa_summary.json
  --generated-at <value>     Override manifest timestamp for deterministic rebuilds
`)
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function assertFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required file: ${filePath}`)
  }
}

function unzipBuffer(zipPath, entry) {
  return execFileSync('unzip', ['-p', zipPath, entry], {
    maxBuffer: 200 * 1024 * 1024,
  })
}

function unzipText(zipPath, entry) {
  return execFileSync('unzip', ['-p', zipPath, entry], {
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  })
}

function xmlDecode(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function getXmlAttribute(xml, name) {
  const match = xml.match(new RegExp(`${name}="([^"]*)"`, 'u'))
  return match ? xmlDecode(match[1]) : ''
}

function readSharedStrings(xlsxPath) {
  let xml = ''
  try {
    xml = unzipText(xlsxPath, 'xl/sharedStrings.xml')
  } catch {
    return []
  }

  const strings = []
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gu)) {
    const textParts = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)].map((part) => xmlDecode(part[1]))
    strings.push(textParts.join(''))
  }
  return strings
}

function workbookSheetPath(xlsxPath, sheetName) {
  const workbookXml = unzipText(xlsxPath, 'xl/workbook.xml')
  const relsXml = unzipText(xlsxPath, 'xl/_rels/workbook.xml.rels')
  const sheetPattern = new RegExp(`<sheet\\b[^>]*name="${sheetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`, 'u')
  const sheetMatch = workbookXml.match(sheetPattern)
  if (!sheetMatch) {
    throw new Error(`Workbook sheet not found: ${sheetName}`)
  }

  const relationshipId = getXmlAttribute(sheetMatch[0], 'r:id')
  const relPattern = new RegExp(`<Relationship\\b[^>]*Id="${relationshipId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`, 'u')
  const relationshipMatch = relsXml.match(relPattern)
  if (!relationshipMatch) {
    throw new Error(`Workbook relationship not found for ${sheetName}`)
  }

  const target = getXmlAttribute(relationshipMatch[0], 'Target')
  return path.posix.join('xl', target)
}

function columnName(cellRef) {
  return String(cellRef).replace(/[0-9]/gu, '')
}

function cellValue(cellXml, cellBody, sharedStrings) {
  const type = getXmlAttribute(cellXml, 't')
  const valueMatch = cellBody.match(/<v>([\s\S]*?)<\/v>/u)
  if (!valueMatch) return ''
  const rawValue = xmlDecode(valueMatch[1])
  if (type === 's') {
    return sharedStrings[Number(rawValue)] ?? ''
  }
  return rawValue
}

function normalizeDbuid(value) {
  const clean = String(value ?? '').trim().replace(/\.0$/u, '')
  return clean ? clean.padStart(11, '0') : ''
}

function normalizeChsaCode(value) {
  const clean = String(value ?? '').trim().replace(/\.0$/u, '')
  return clean ? clean.padStart(4, '0') : ''
}

function readCrosswalkRows(xlsxPath) {
  const sharedStrings = readSharedStrings(xlsxPath)
  const sheetPath = workbookSheetPath(xlsxPath, CROSSWALK_SHEET_NAME)
  const sheetXml = unzipText(xlsxPath, sheetPath)
  const rows = []

  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*r="([0-9]+)"[^>]*>([\s\S]*?)<\/row>/gu)) {
    const rowNumber = Number(rowMatch[1])
    const cells = new Map()
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gu)) {
      const ref = getXmlAttribute(cellMatch[1], 'r')
      cells.set(columnName(ref), cellValue(cellMatch[1], cellMatch[2], sharedStrings))
    }

    if (rowNumber === 1) {
      if (cells.get('A') !== 'DBUID' || cells.get('B') !== 'CHSA_CD') {
        throw new Error(`Unexpected ${CROSSWALK_SHEET_NAME} headers: ${cells.get('A')}, ${cells.get('B')}`)
      }
      continue
    }

    const dbuid = normalizeDbuid(cells.get('A'))
    const chsaCode = normalizeChsaCode(cells.get('B'))
    if (dbuid && chsaCode) rows.push({ dbuid, chsaCode })
  }

  return rows
}

function readDbfRows(filePath) {
  const buffer = fs.readFileSync(filePath)
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  return parseDbf(arrayBuffer)
}

function toNumber(value, fallback = 0) {
  if (value == null || value === '') return fallback
  const parsed = Number(String(value).replace(/,/gu, ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

function round(value, digits = 6) {
  const scale = 10 ** digits
  return Math.round(Number(value) * scale) / scale
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ''))
}

function sortByStringId(left, right, key) {
  return String(left[key] ?? '').localeCompare(String(right[key] ?? ''))
}

function makeSourceFiles(args) {
  const workbookSource = args.crosswalkXlsx
    ? `${path.relative(bcdatamapperRoot, args.crosswalkXlsx)} sheet ${CROSSWALK_SHEET_NAME}`
    : `${args.crosswalkEntry} sheet ${CROSSWALK_SHEET_NAME}`
  const defaultRawArchive = path.resolve(DEFAULT_RAW_ARCHIVE)
  const rawArchive = path.resolve(args.rawArchive)
  const rawSource = rawArchive === defaultRawArchive
    ? 'BCCDC/Angela Data and Script/BCCDC raw archive'
    : path.relative(bcdatamapperRoot, rawArchive)
  return [
    workbookSource,
    `${rawSource}/bc_db_pop_dwell_2021.dbf`,
    `${rawSource}/db21.dbf`,
    `${path.relative(bcdatamapperRoot, args.bcmohIndex)}`,
  ]
}

function buildSummary(records) {
  const summaryByCode = new Map()

  for (const record of records) {
    if (!summaryByCode.has(record.chsaCode)) {
      summaryByCode.set(record.chsaCode, {
        chsaCode: record.chsaCode,
        chsaName: record.chsaName,
        lhaCode: record.lhaCode,
        lhaName: record.lhaName,
        hsdaCode: record.hsdaCode,
        hsdaName: record.hsdaName,
        healthAuthorityCode: record.healthAuthorityCode,
        healthAuthorityName: record.healthAuthorityName,
        urbanRural: record.urbanRural,
        dbCount: 0,
        population: 0,
        dwellings: 0,
        households: 0,
        areaSqKm: 0,
        populationDensity: 0,
      })
    }

    const summary = summaryByCode.get(record.chsaCode)
    summary.dbCount += 1
    summary.population += record.population
    summary.dwellings += record.dwellings
    summary.households += record.households
    summary.areaSqKm += record.areaSqKm
  }

  return [...summaryByCode.values()]
    .map((summary) => ({
      ...summary,
      areaSqKm: round(summary.areaSqKm, 4),
      populationDensity: summary.areaSqKm > 0 ? round(summary.population / summary.areaSqKm, 6) : 0,
    }))
    .sort((left, right) => sortByStringId(left, right, 'chsaCode'))
}

function extractCrosswalkWorkbook(args) {
  if (args.crosswalkXlsx) {
    assertFile(args.crosswalkXlsx)
    return { xlsxPath: args.crosswalkXlsx, cleanup: () => {} }
  }

  assertFile(args.dbDataZip)
  const tmpParent = path.join(censusDir, 'tmp')
  fs.mkdirSync(tmpParent, { recursive: true })
  const tmpDir = fs.mkdtempSync(path.join(tmpParent, 'bc-db-crosswalk-'))
  const xlsxPath = path.join(tmpDir, 'DB_CHSA_Crosswalk_2021.xlsx')
  fs.writeFileSync(xlsxPath, unzipBuffer(args.dbDataZip, args.crosswalkEntry))
  return {
    xlsxPath,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const populationDbfPath = path.join(args.rawArchive, 'bc_db_pop_dwell_2021.dbf')
  const attributeDbfPath = path.join(args.rawArchive, 'db21.dbf')

  assertFile(populationDbfPath)
  assertFile(attributeDbfPath)
  assertFile(args.bcmohIndex)

  const workbook = extractCrosswalkWorkbook(args)
  try {
    const crosswalkRows = readCrosswalkRows(workbook.xlsxPath)
    const duplicateDbuids = []
    const crosswalkByDbuid = new Map()
    for (const row of crosswalkRows) {
      if (crosswalkByDbuid.has(row.dbuid)) duplicateDbuids.push(row.dbuid)
      crosswalkByDbuid.set(row.dbuid, row.chsaCode)
    }
    if (duplicateDbuids.length) {
      throw new Error(`Duplicate DBUIDs in DB-CHSA crosswalk: ${duplicateDbuids.slice(0, 10).join(', ')}`)
    }

    const populationRows = readDbfRows(populationDbfPath)
    const attributeRows = readDbfRows(attributeDbfPath)
    const populationByDbuid = new Map(populationRows.map((row) => [normalizeDbuid(row.DBUID), row]))
    const attributeByDbuid = new Map(attributeRows.map((row) => [normalizeDbuid(row.DBUID), row]))
    const healthIndex = JSON.parse(fs.readFileSync(args.bcmohIndex, 'utf8'))
    const chsaByCode = new Map((healthIndex.communityHealthServiceAreas ?? []).map((row) => [normalizeChsaCode(row.code), row]))

    const missingPopulationDbuidSample = []
    const missingAttributeDbuidSample = []
    const records = [...crosswalkByDbuid.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([dbuid, chsaCode]) => {
        const population = populationByDbuid.get(dbuid)
        const attributes = attributeByDbuid.get(dbuid)
        const chsa = chsaByCode.get(chsaCode) ?? { code: chsaCode }

        if (!population && missingPopulationDbuidSample.length < 25) missingPopulationDbuidSample.push(dbuid)
        if (!attributes && missingAttributeDbuidSample.length < 25) missingAttributeDbuidSample.push(dbuid)

        const areaSqKm = toNumber(population?.DBAREA, toNumber(attributes?.LANDAREA))
        const dbPopulation = toNumber(population?.DBPOP2021)
        return compactObject({
          dbuid,
          dguid: attributes?.DGUID,
          areaSqKm,
          population: dbPopulation,
          dwellings: toNumber(population?.DBTDWELL21),
          households: toNumber(population?.DBURDWEL21),
          populationDensity: areaSqKm > 0 ? round(dbPopulation / areaSqKm, 6) : 0,
          prId: attributes?.PRUID ?? population?.PRUID,
          cdId: attributes?.CDUID ?? (population?.PRUID && population?.CD ? `${population.PRUID}${String(population.CD).padStart(2, '0')}` : undefined),
          daId: attributes?.DAUID ?? population?.DAUID,
          adaId: attributes?.ADAUID ?? population?.ADAUID,
          csdId: attributes?.CSDUID ?? population?.CSDUID,
          csdName: population?.CSDNAME,
          csdType: population?.CSDTYPE,
          cmaId: attributes?.CMAUID,
          ctId: attributes?.CTUID,
          ctName: attributes?.CTNAME,
          representativeLatitude: toNumber(attributes?.DBRPLAT, undefined),
          representativeLongitude: toNumber(attributes?.DBRPLONG, undefined),
          chsaCode,
          chsaName: chsa.name,
          lhaCode: chsa.lhaCode,
          lhaName: chsa.lhaName,
          hsdaCode: chsa.hsdaCode,
          hsdaName: chsa.hsdaName,
          healthAuthorityCode: chsa.healthAuthorityCode,
          healthAuthorityName: chsa.healthAuthorityName,
          urbanRural: chsa.urbanRural,
        })
      })

    const crosswalkDbuidSet = new Set(crosswalkByDbuid.keys())
    const extraPopulationDbuids = [...populationByDbuid.keys()]
      .filter((dbuid) => dbuid && !crosswalkDbuidSet.has(dbuid))
      .sort()
    const extraAttributeDbuids = [...attributeByDbuid.keys()]
      .filter((dbuid) => dbuid && !crosswalkDbuidSet.has(dbuid))
      .sort()
    const summaryByChsa = buildSummary(records)
    const missingPopulationDbCount = records.filter((record) => !populationByDbuid.has(record.dbuid)).length
    const missingAttributeDbCount = records.filter((record) => !attributeByDbuid.has(record.dbuid)).length

    const manifest = {
      generatedAt: args.generatedAt,
      sourceFiles: makeSourceFiles(args),
      sourceNotes: [
        'Crosswalk and DB attributes are keyed to the BCCDC db21 shapefile package.',
        'Population, total dwellings, usual-resident dwellings, and DB area come from bc_db_pop_dwell_2021.dbf.',
        'CHSA names and parent health hierarchy fields are joined from the local BCMoH boundary index.',
        'The standalone BC_DB_Level_Population.csv in the download folder uses a different DBUID universe and is not used for this app-ready join.',
      ],
      recordCount: records.length,
      matchedDbCount: records.length - missingAttributeDbCount,
      missingPopulationDbCount,
      missingAttributeDbCount,
      extraPopulationDbCount: extraPopulationDbuids.length,
      extraAttributeDbCount: extraAttributeDbuids.length,
      chsaCount: summaryByChsa.length,
      populationTotal: records.reduce((sum, record) => sum + record.population, 0),
      dwellingsTotal: records.reduce((sum, record) => sum + record.dwellings, 0),
      householdsTotal: records.reduce((sum, record) => sum + record.households, 0),
      areaSqKmTotal: round(records.reduce((sum, record) => sum + record.areaSqKm, 0), 4),
      files: {
        records: 'bc_db_population_chsa_crosswalk.json',
        summaryByChsa: 'bc_db_chsa_summary.json',
      },
      missingPopulationDbuidSample,
      missingAttributeDbuidSample,
      extraPopulationDbuidSample: extraPopulationDbuids.slice(0, 25),
      extraAttributeDbuidSample: extraAttributeDbuids.slice(0, 25),
    }

    fs.mkdirSync(args.output, { recursive: true })
    fs.writeFileSync(
      path.join(args.output, 'bc_db_population_chsa_crosswalk.json'),
      JSON.stringify({ manifest, records }),
    )
    fs.writeFileSync(
      path.join(args.output, 'bc_db_chsa_summary.json'),
      JSON.stringify({ manifest, summaryByChsa }),
    )

    console.log(`Wrote ${records.length.toLocaleString()} DB crosswalk records`)
    console.log(`Wrote ${summaryByChsa.length.toLocaleString()} CHSA summaries`)
    console.log(`Output: ${path.relative(bcdatamapperRoot, args.output)}`)
  } finally {
    workbook.cleanup()
  }
}

main()
