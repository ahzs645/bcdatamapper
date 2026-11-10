// The folders this repository publishes on its own Pages site, and how to
// fingerprint them. pages/build-site.mjs assembles the site from here, and
// PGMaps imports this module: its data sync copies the same mappings when it
// runs with every folder local, and its deploy compares the published
// fingerprints with the ones its pinned submodule commit would produce.
//
// Node built-ins only, so the Pages workflow needs no npm install.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative } from 'node:path'

const PLAIN_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/

/** Read and check pages/site.json. Throws on anything that would publish the wrong files. */
export function readSite(root) {
  const site = JSON.parse(readFileSync(join(root, 'pages', 'site.json'), 'utf8'))
  if (!Array.isArray(site.folders) || site.folders.length === 0)
    throw new Error('site.json: "folders" must list at least one folder')
  if (!Array.isArray(site.mappings)) throw new Error('site.json: "mappings" must be an array')
  for (const folder of site.folders) {
    if (typeof folder !== 'string' || !PLAIN_PATH.test(folder) || folder.includes('/')) {
      throw new Error(`site.json: folder ${JSON.stringify(folder)} must be one top-level folder name`)
    }
  }
  const covered = new Set()
  for (const mapping of site.mappings) {
    const [source, target] = Array.isArray(mapping) ? mapping : []
    if (typeof source !== 'string' || !PLAIN_PATH.test(source) || source.split('/').includes('..')) {
      throw new Error(`site.json: invalid source ${JSON.stringify(source)}`)
    }
    if (typeof target !== 'string' || !PLAIN_PATH.test(target) || target.split('/').includes('..')) {
      throw new Error(`site.json: invalid target ${JSON.stringify(target)}`)
    }
    const folder = target.split('/')[0]
    if (!site.folders.includes(folder)) throw new Error(`site.json: target ${target} is outside the listed folders`)
    if (!existsSync(join(root, source))) throw new Error(`site.json: source ${source} does not exist`)
    covered.add(folder)
  }
  const empty = site.folders.filter((folder) => !covered.has(folder))
  if (empty.length > 0) throw new Error(`site.json: no mapping fills ${empty.join(', ')}`)
  return { folders: [...site.folders], mappings: site.mappings.map(([source, target]) => [source, target]) }
}

/** Every file a mapping publishes, as [absolute source file, published path below /data]. */
export function siteFiles(root, site) {
  const files = []
  for (const [source, target] of site.mappings) {
    const visit = (path) => {
      if (statSync(path).isDirectory()) {
        for (const name of readdirSync(path).sort()) visit(join(path, name))
      } else {
        files.push([path, posix.join(target, relative(join(root, source), path).split('\\').join('/'))])
      }
    }
    visit(join(root, source))
  }
  return files.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
}

/**
 * A fingerprint per folder: SHA-256 over each published path and its file's
 * SHA-256, in path order, plus the file count and bytes. Two checkouts that
 * would publish byte-identical folders get the same fingerprint.
 */
export function folderFingerprints(root, site) {
  const folders = Object.fromEntries(
    site.folders.map((folder) => [folder, { files: 0, bytes: 0, hash: createHash('sha256') }]),
  )
  for (const [source, published] of siteFiles(root, site)) {
    const entry = folders[published.split('/')[0]]
    const content = readFileSync(source)
    entry.files += 1
    entry.bytes += content.length
    entry.hash.update(`${published}\0${createHash('sha256').update(content).digest('hex')}\n`)
  }
  return Object.fromEntries(
    Object.entries(folders).map(([folder, { files, bytes, hash }]) => [
      folder,
      { files, bytes, sha256: hash.digest('hex') },
    ]),
  )
}
