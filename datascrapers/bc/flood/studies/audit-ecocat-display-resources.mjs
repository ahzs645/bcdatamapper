import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ECOCAT_DIR = join(HERE, 'cache', 'ecocat')
const COLLECTIONS_FILE = join(ECOCAT_DIR, 'manifest.json')
const OUTPUT_FILE = join(ECOCAT_DIR, 'display-resource-audit.json')
const DOCUMENT_PATH = '/pub/acat/documents/'
const SOURCE_SECTIONS = [
  'Report Documents',
  'Map Plotfiles',
  'Data Files',
  'Digital Map Files',
  'All Documents',
]

function decodeHtml(value = '') {
  return value
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeDocumentUrl(value, pageUrl) {
  try {
    const url = new URL(decodeHtml(value), pageUrl)
    if (url.protocol !== 'https:' || url.hostname !== 'a100.gov.bc.ca' || !url.pathname.startsWith(DOCUMENT_PATH)) return null
    return url.href
  } catch {
    return null
  }
}

function extractField(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = html.match(new RegExp(`<B>\\s*${escaped}:?\\s*<\\/B>\\s*(?:&nbsp;)?\\s*([\\s\\S]*?)<BR\\s*\\/?>`, 'i'))
  return match ? decodeHtml(match[1]) || null : null
}

function extractCollectionMetadata(html) {
  const heading = html.match(/<H1>\s*Report:\s*([\s\S]*?)<\/H1>/i)
  const audienceEnd = /<B>\s*Audience:\s*<\/B>[\s\S]*?<BR\s*\/?>([\s\S]*?)<BR\s*\/?>(?=[\s\S]*?<B>\s*Report Type\s*<\/B>)/i.exec(html)
  const reportType = /<B>\s*Report Type\s*<\/B>[\s\S]*?<TD[^>]*>\s*&nbsp;\s*<\/TD>[\s\S]*?<TD[^>]*>([\s\S]*?)<\/TD>/i.exec(html)
  const subject = /<B>\s*Subject\s*<\/B>[\s\S]*?<TD[^>]*>\s*&nbsp;\s*<\/TD>[\s\S]*?<TD[^>]*>([\s\S]*?)<\/TD>/i.exec(html)
  return {
    title: heading ? decodeHtml(heading[1]) : null,
    author: extractField(html, 'Author'),
    old_reference_number: extractField(html, 'Old Reference Number'),
    old_reference_system: extractField(html, 'Old Reference System'),
    date_published: extractField(html, 'Date Published'),
    report_id: extractField(html, 'Report ID'),
    audience: extractField(html, 'Audience'),
    description: audienceEnd ? decodeHtml(audienceEnd[1]) || null : null,
    report_type: reportType ? decodeHtml(reportType[1]) || null : null,
    subject: subject ? decodeHtml(subject[1]) || null : null,
  }
}

function attachmentPageDetails(html, pageUrl) {
  const headings = []
  const headingPattern = /<TD\b[^>]*align=["']center["'][^>]*>[\s\S]*?<font\b[^>]*>([\s\S]*?)<\/font>/gi
  let match
  while ((match = headingPattern.exec(html))) {
    const label = decodeHtml(match[1])
    if (SOURCE_SECTIONS.includes(label)) headings.push({ index: match.index, label })
  }

  const details = new Map()
  const anchorPattern = /<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>([\s\S]*?)<\/font>/gi
  while ((match = anchorPattern.exec(html))) {
    const url = normalizeDocumentUrl(match[1], pageUrl)
    if (!url) continue
    const sourceSection = headings.filter((heading) => heading.index < match.index).at(-1)?.label ?? 'Unclassified'
    const suffix = decodeHtml(match[3])
    const description = suffix.replace(/\([a-z0-9]+\s*\/\s*[\d.]+\s*(?:bytes?|kb|mb|gb)\)\s*$/i, '').trim() || null
    details.set(url, { source_section: sourceSection, source_description: description })
  }
  return details
}

function resourceTags(attachment, sourceSection) {
  const label = attachment.label.toLowerCase()
  const extension = extname(attachment.filename).slice(1).toLowerCase()
  const tags = new Set()

  if (sourceSection === 'Report Documents' || sourceSection === 'All Documents' || /\b(report|design brief|assessment|study|project summary)\b/.test(label)) tags.add('report-or-summary')
  if (/floodplain\s+map|flood\s+map|mapsheet/.test(label)) tags.add('floodplain-map')
  if (/\b(index|key plan|explanation|legend)\b/.test(label)) tags.add('index-or-guide')
  if (/\b(cross[ -]?section|xs\b|drawing|plan\b|plot\b|profile|mosaic|bathymetric|bridge|thalweg)\b/.test(label)) tags.add('technical-drawing-or-profile')
  if (/\b(high water mark|ice jam|photo|photograph)\b/.test(label)) tags.add('observed-event-or-photo')
  if (/\bgaug(?:e|ing)|station description/.test(label)) tags.add('station-reference')
  if (['txt', 'zip', 'dat', 'dwg', 'xls', 'c39'].includes(extension) || /\b(hec|model|coordinate|data file|profile statements?)\b/.test(label)) tags.add('model-or-source-data')
  if (['gif', 'jpg', 'jpeg', 'png'].includes(extension)) tags.add('image')
  if (extension === 'pdf') tags.add('pdf')
  return [...tags]
}

function presentation(extension, status) {
  if (status !== 'existing' && status !== 'downloaded') return 'unavailable'
  if (extension === 'pdf') return 'official-link-pdf'
  if (['gif', 'jpg', 'jpeg', 'png'].includes(extension)) return 'official-link-image'
  if (extension === 'txt') return 'official-link-text'
  return 'official-download'
}

function increment(target, key, amount = 1) {
  target[key] = (target[key] ?? 0) + amount
}

if (!existsSync(COLLECTIONS_FILE)) throw new Error(`Missing ${COLLECTIONS_FILE}; run flood-studies:ecocat first`)

const collectionIndex = JSON.parse(await readFile(COLLECTIONS_FILE, 'utf8'))
const sectionCounts = {}
const tagCounts = {}
const presentationCounts = {}
const extensionCounts = {}
const tagStudies = new Map()
const sectionStudies = new Map()
const collectionUrls = new Map()
const resourceUrls = new Map()
const studies = []

for (const collection of collectionIndex.collections) {
  if (!collectionUrls.has(collection.page_url)) collectionUrls.set(collection.page_url, [])
  collectionUrls.get(collection.page_url).push(collection.study_id)
  const manifestPath = join(ECOCAT_DIR, collection.manifest)
  const collectionManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const pagePath = join(dirname(manifestPath), 'page.html')
  const html = await readFile(pagePath, 'utf8')
  const pageDetails = attachmentPageDetails(html, collection.page_url)
  const metadata = extractCollectionMetadata(html)
  const resources = collectionManifest.attachments.map((attachment) => {
    if (!resourceUrls.has(attachment.url)) resourceUrls.set(attachment.url, [])
    resourceUrls.get(attachment.url).push(collection.study_id)
    const details = pageDetails.get(attachment.url) ?? { source_section: 'Unclassified', source_description: null }
    const extension = extname(attachment.filename).slice(1).toLowerCase() || 'unknown'
    const tags = resourceTags(attachment, details.source_section)
    const accessStatus = attachment.download?.status ?? 'unknown'
    const presentationMode = presentation(extension, accessStatus)
    increment(sectionCounts, details.source_section)
    increment(extensionCounts, extension)
    increment(presentationCounts, presentationMode)
    if (!sectionStudies.has(details.source_section)) sectionStudies.set(details.source_section, new Set())
    sectionStudies.get(details.source_section).add(collection.study_id)
    for (const tag of tags) {
      increment(tagCounts, tag)
      if (!tagStudies.has(tag)) tagStudies.set(tag, new Set())
      tagStudies.get(tag).add(collection.study_id)
    }
    return {
      label: attachment.label,
      source_description: details.source_description,
      source_section: details.source_section,
      tags,
      extension,
      media_type: attachment.probe?.content_type ?? null,
      bytes: attachment.download?.bytes ?? attachment.probe?.content_length ?? null,
      source_url: attachment.url,
      access_status: accessStatus,
      presentation: presentationMode,
    }
  })

  const available = resources.filter((resource) => resource.presentation !== 'unavailable')
  const featured = available
    .filter((resource) => resource.tags.some((tag) => ['report-or-summary', 'floodplain-map', 'observed-event-or-photo', 'station-reference'].includes(tag)))
    .slice(0, 12)

  studies.push({
    study_id: collection.study_id,
    title: collection.title,
    official_collection_url: collection.page_url,
    metadata,
    resource_count: resources.length,
    available_resource_count: available.length,
    featured_resources: featured,
    resources,
  })
}

const coverage = (counts, sets) => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([key, resourceCount]) => [key, {
  resources: resourceCount,
  studies: sets.get(key)?.size ?? 0,
}]))

const output = {
  title: 'EcoCat flood-study display and outbound-resource audit',
  source_manifest: 'manifest.json',
  redistribution: collectionIndex.redistribution,
  recommendation: 'Display collection metadata and source links; do not deploy or inline-embed mirrored files without redistribution permission.',
  counts: {
    studies: studies.length,
    unique_official_collections: collectionUrls.size,
    resources: studies.reduce((sum, study) => sum + study.resource_count, 0),
    unique_resource_urls: resourceUrls.size,
    available_resources: studies.reduce((sum, study) => sum + study.available_resource_count, 0),
    official_collection_links: studies.filter((study) => study.official_collection_url).length,
    studies_with_featured_resources: studies.filter((study) => study.featured_resources.length > 0).length,
  },
  duplicate_collection_mappings: [...collectionUrls.entries()]
    .filter(([, studyIds]) => studyIds.length > 1)
    .map(([official_collection_url, study_ids]) => ({ official_collection_url, study_ids })),
  source_section_coverage: coverage(sectionCounts, sectionStudies),
  tag_coverage: coverage(tagCounts, tagStudies),
  presentation_counts: Object.fromEntries(Object.entries(presentationCounts).sort(([a], [b]) => a.localeCompare(b))),
  extension_counts: Object.fromEntries(Object.entries(extensionCounts).sort(([a], [b]) => a.localeCompare(b))),
  studies,
}

await writeFile(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`)
console.log(`Wrote ${OUTPUT_FILE}`)
console.log(JSON.stringify({ counts: output.counts, source_section_coverage: output.source_section_coverage, tag_coverage: output.tag_coverage, presentation_counts: output.presentation_counts }, null, 2))
