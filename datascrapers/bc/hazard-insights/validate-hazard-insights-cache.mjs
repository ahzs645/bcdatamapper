#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
let cacheDir = join(SCRIPT_DIR, 'cache')
const requested = []

for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index]
  if (value === '--cache-dir') cacheDir = resolve(process.argv[++index])
  else if (value === '--source') requested.push(process.argv[++index])
  else if (value === '--help' || value === '-h') {
    console.log('Usage: node validate-hazard-insights-cache.mjs [--cache-dir path] [--source slug]')
    process.exit(0)
  } else throw new Error(`Unknown argument: ${value}`)
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

const directories = requested.length
  ? requested
  : (await readdir(cacheDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

let totalFeatures = 0
let totalBytes = 0
let validatedSources = 0
for (const slug of directories) {
  const sourceDir = join(cacheDir, slug)
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(sourceDir, 'download-manifest.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' && !requested.length) continue
    throw error
  }
  if (!manifest.complete) throw new Error(`${slug}: manifest is incomplete`)

  let featureCount = 0
  let compressedBytes = 0
  for (const shard of manifest.shards) {
    const path = join(sourceDir, shard.file)
    const info = await stat(path)
    if (info.size !== shard.bytes) throw new Error(`${slug}: size mismatch for ${shard.file}`)
    const digest = await sha256(path)
    if (digest !== shard.sha256) throw new Error(`${slug}: SHA-256 mismatch for ${shard.file}`)
    featureCount += shard.featureCount
    compressedBytes += shard.bytes
  }
  if (featureCount !== manifest.downloadedFeatureCount || featureCount !== manifest.liveFeatureCount) {
    throw new Error(`${slug}: feature-count mismatch`)
  }
  if (compressedBytes !== manifest.compressedBytes) throw new Error(`${slug}: byte-count mismatch`)

  validatedSources += 1
  totalFeatures += featureCount
  totalBytes += compressedBytes
  console.log(`${slug}: ${featureCount.toLocaleString()} records, ${(compressedBytes / 1024 / 1024).toFixed(1)} MiB OK`)
}

console.log(`Validated ${validatedSources} sources, ${totalFeatures.toLocaleString()} records, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB compressed`)
