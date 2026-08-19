#!/usr/bin/env node

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { XMLParser } from 'fast-xml-parser'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_BUILD_ROOT = resolve(process.env.PGMAPS_ROOT ?? process.cwd(), 'build/bc-outdoors-plans')

function asArray(value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function slugify(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'outdoor-plan'
}

function textValue(value) {
  if (value == null) return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  if (typeof value === 'object') {
    return String(value['#text'] ?? value.__cdata ?? value['#cdata'] ?? '').trim()
  }
  return ''
}

function plainDescription(value) {
  return textValue(value)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&bull;|&#8226;/gi, '•')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function coordinates(value) {
  const raw = textValue(value)
  if (!raw) return []
  return raw
    .split(/\s+/)
    .map((tuple) => tuple.split(',').map(Number))
    .filter((position) => position.length >= 2 && Number.isFinite(position[0]) && Number.isFinite(position[1]))
    .map((position) => position.slice(0, Number.isFinite(position[2]) ? 3 : 2))
}

function pointGeometry(value) {
  const position = coordinates(value?.coordinates)[0]
  return position ? { type: 'Point', coordinates: position } : null
}

function lineGeometry(value) {
  const positions = coordinates(value?.coordinates)
  return positions.length >= 2 ? { type: 'LineString', coordinates: positions } : null
}

function polygonGeometry(value) {
  const outer = coordinates(value?.outerBoundaryIs?.LinearRing?.coordinates)
  if (outer.length < 4) return null
  const holes = asArray(value?.innerBoundaryIs)
    .map((boundary) => coordinates(boundary?.LinearRing?.coordinates))
    .filter((ring) => ring.length >= 4)
  return { type: 'Polygon', coordinates: [outer, ...holes] }
}

function collectGeometryValues(container) {
  const geometries = []
  for (const value of asArray(container?.Point)) {
    const geometry = pointGeometry(value)
    if (geometry) geometries.push(geometry)
  }
  for (const value of asArray(container?.LineString)) {
    const geometry = lineGeometry(value)
    if (geometry) geometries.push(geometry)
  }
  for (const value of asArray(container?.Polygon)) {
    const geometry = polygonGeometry(value)
    if (geometry) geometries.push(geometry)
  }
  for (const value of asArray(container?.MultiGeometry)) {
    geometries.push(...collectGeometryValues(value))
  }
  return geometries
}

function combineGeometries(geometries) {
  if (geometries.length === 0) return null
  if (geometries.length === 1) return geometries[0]
  const types = new Set(geometries.map((geometry) => geometry.type))
  if (types.size === 1 && types.has('Point')) {
    return { type: 'MultiPoint', coordinates: geometries.map((geometry) => geometry.coordinates) }
  }
  if (types.size === 1 && types.has('LineString')) {
    return { type: 'MultiLineString', coordinates: geometries.map((geometry) => geometry.coordinates) }
  }
  if (types.size === 1 && types.has('Polygon')) {
    return { type: 'MultiPolygon', coordinates: geometries.map((geometry) => geometry.coordinates) }
  }
  return { type: 'GeometryCollection', geometries }
}

export function classifyPlanningFeature({ name, description, folderPath }) {
  const context = `${folderPath.join(' ')} ${name} ${description}`.toLowerCase()
  const folder = folderPath.join(' ').toLowerCase()

  if (/50\s*-?\s*75\s*km|50\s*km|75\s*km|range\s*limit/.test(context)) return 'travel-range'
  if (folder.includes('motor vehicle closed areas') || /closed area/.test(name.toLowerCase())) return 'vehicle-closure'
  if (folder.includes('designated roads') || name.toLowerCase().includes('designated road')) return 'designated-corridor'
  if (folder.includes('where you can hunt') || /huntable area/.test(name.toLowerCase())) return 'legal-hunt-area'
  if (folder.includes('context only') || /mu\s*7-42\s*boundary/i.test(name)) return 'management-context'
  if (folder.includes('river labels')) return 'map-label'
  if (folder.includes('public boat launches') || description.toLowerCase().includes('formal public boat launch')) return 'formal-access'
  if (
    folder.includes('highway river crossings') ||
    folder.includes('roads approaching') ||
    /possible access|access road|launch candidate|informal/.test(context)
  ) return 'access-candidate'
  if (folder.includes('other rec sites') || /recreation (site|reserve)/.test(description.toLowerCase())) return 'recreation-site'
  if (folder.includes('navigable rivers')) return 'navigable-water'
  return 'personal-note'
}

function planningStage(planningClass) {
  if (['legal-hunt-area', 'management-context'].includes(planningClass)) return 'eligibility'
  if ([
    'vehicle-closure',
    'designated-corridor',
    'navigable-water',
    'formal-access',
    'access-candidate',
    'recreation-site',
  ].includes(planningClass)) return 'access'
  return 'field-plan'
}

function verificationStatus({ planningClass, name, description, folderPath }) {
  const context = `${folderPath.join(' ')} ${name} ${description}`.toLowerCase()
  if (planningClass === 'management-context') return 'context-only'
  if (/possible|candidate|informal|verify|confirm/.test(context)) return 'verify'
  if (['formal-access', 'legal-hunt-area', 'vehicle-closure', 'designated-corridor'].includes(planningClass)) {
    return 'source-described'
  }
  return 'user-provided'
}

function normalizePlacemark(placemark, folderPath, index) {
  const name = textValue(placemark.name) || `Placemark ${index + 1}`
  const descriptionHtml = textValue(placemark.description)
  const description = plainDescription(placemark.description)
  const geometry = combineGeometries(collectGeometryValues(placemark))
  if (!geometry) return null
  let planningClass = classifyPlanningFeature({ name, description, folderPath })
  if (
    geometry.type === 'Point' &&
    planningClass === 'legal-hunt-area' &&
    !name.toLowerCase().includes('huntable area')
  ) {
    planningClass = 'map-label'
  }
  const kmlId = String(placemark['@_id'] ?? '').trim()

  return {
    type: 'Feature',
    id: kmlId || `plan-${index + 1}`,
    geometry,
    properties: {
      planFeatureId: kmlId || `plan-${index + 1}`,
      name,
      description,
      descriptionHtml: descriptionHtml || null,
      folderPath,
      planningClass,
      planningStage: planningStage(planningClass),
      authority: 'user-supplied',
      verification: verificationStatus({ planningClass, name, description, folderPath }),
      renderDefault: planningClass !== 'map-label',
      privacy: 'private-plan',
      styleUrl: textValue(placemark.styleUrl) || null,
    },
  }
}

function walkContainer(container, folderPath, features) {
  for (const placemark of asArray(container?.Placemark)) {
    const feature = normalizePlacemark(placemark, folderPath, features.length)
    if (feature) features.push(feature)
  }
  for (const folder of asArray(container?.Folder)) {
    const folderName = textValue(folder.name) || 'Untitled folder'
    walkContainer(folder, [...folderPath, folderName], features)
  }
}

export function parsePlanningKml(xml, sourceName = 'plan.kml') {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    trimValues: true,
    parseTagValue: false,
    processEntities: true,
  })
  const parsed = parser.parse(xml)
  const document = parsed?.kml?.Document ?? parsed?.Document
  if (!document) throw new Error('KML does not contain a Document element')
  const name = textValue(document.name) || basename(sourceName, '.kml')
  const features = []
  walkContainer(document, [], features)
  if (features.length === 0) throw new Error('KML does not contain any supported placemark geometry')

  const classCounts = {}
  const geometryCounts = {}
  for (const feature of features) {
    classCounts[feature.properties.planningClass] = (classCounts[feature.properties.planningClass] ?? 0) + 1
    geometryCounts[feature.geometry.type] = (geometryCounts[feature.geometry.type] ?? 0) + 1
  }

  return {
    collection: {
      type: 'FeatureCollection',
      name,
      metadata: {
        sourceType: 'user-supplied-kml',
        sourceName: basename(sourceName),
        privacy: 'private-plan',
        featureCount: features.length,
      },
      features,
    },
    report: {
      name,
      sourceName: basename(sourceName),
      featureCount: features.length,
      classCounts,
      geometryCounts,
      privacy: 'private-plan',
      publishToPublicR2: false,
    },
  }
}

function parseArgs(argv) {
  const args = { inputPath: null, outputDir: null }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--output') args.outputDir = resolve(argv[++index])
    else if (token === '--help' || token === '-h') args.help = true
    else if (!args.inputPath) args.inputPath = resolve(token)
    else throw new Error(`Unknown argument: ${token}`)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.inputPath) {
    console.log('Usage: node import-planning-kml.mjs <plan.kml> [--output <directory>]')
    process.exit(args.help ? 0 : 64)
  }
  const xml = await readFile(args.inputPath, 'utf8')
  const parsed = parsePlanningKml(xml, args.inputPath)
  const outputDir = args.outputDir ?? join(DEFAULT_BUILD_ROOT, slugify(parsed.report.name))
  await mkdir(outputDir, { recursive: true })
  await writeFile(join(outputDir, 'plan.geojson'), `${JSON.stringify(parsed.collection)}\n`)
  await writeFile(join(outputDir, 'plan-manifest.json'), `${JSON.stringify(parsed.report, null, 2)}\n`)
  console.log(JSON.stringify({ outputDir, ...parsed.report }, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
