#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scraperDirectory = path.dirname(fileURLToPath(import.meta.url));

function parseArguments(argv) {
  const options = {
    cacheDirectory: path.join(scraperDirectory, 'cache', 'separate-grids'),
    configFile: path.join(scraperDirectory, 'separate-products.json'),
    concurrency: 3,
    retries: 3,
    timeoutMs: 300_000,
    families: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--cache-dir' && value) options.cacheDirectory = path.resolve(value);
    else if (argument === '--config' && value) options.configFile = path.resolve(value);
    else if (argument === '--concurrency' && value) options.concurrency = Number(value);
    else if (argument === '--retries' && value) options.retries = Number(value);
    else if (argument === '--timeout-ms' && value) options.timeoutMs = Number(value);
    else if (argument === '--families' && value) {
      options.families = new Set(value.split(',').map((item) => item.trim()).filter(Boolean));
    } else if (argument === '--help') {
      console.log(`Usage: node download-separate-grids.mjs [options]

Options:
  --cache-dir PATH       Raw downloads and manifest directory
  --config PATH          Separate-grid product configuration
  --families LIST        Comma-separated family filter (humidex,spei)
  --concurrency N        Simultaneous downloads (default: 3)
  --retries N            Attempts per file (default: 3)
  --timeout-ms N         Timeout per attempt (default: 300000)`);
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
    index += 1;
  }
  for (const [name, value] of Object.entries({
    concurrency: options.concurrency,
    retries: options.retries,
    timeoutMs: options.timeoutMs,
  })) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  return options;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function requestsFrom(config, familyFilter) {
  const requests = [];
  for (const family of config.families ?? []) {
    if (familyFilter && !familyFilter.has(family.id)) continue;
    for (const variable of family.variables ?? []) {
      for (const datasetType of family.dataset_types ?? []) {
        for (const month of family.months ?? []) {
          requests.push({
            family: family.id,
            datasetName: family.dataset_name,
            datasetType,
            variable,
            month,
          });
        }
      }
    }
  }
  return requests;
}

function payloadFor(config, request) {
  return {
    dataset_name: request.datasetName,
    dataset_type: request.datasetType,
    format: 'netcdf',
    month: request.month,
    var: request.variable,
    zipped: true,
    bbox: config.bbox,
  };
}

async function download(config, request, options) {
  const familyDirectory = path.join(options.cacheDirectory, 'raw', request.family);
  await mkdir(familyDirectory, { recursive: true });
  const file = path.join(
    familyDirectory,
    `${request.variable}-${request.datasetType}-${request.month}.nc`,
  );
  const partial = `${file}.part`;
  try {
    const existing = await stat(file);
    if (existing.size > 8) {
      return {
        ...request,
        status: 'existing',
        bytes: existing.size,
        sha256: await sha256(file),
        file,
      };
    }
  } catch {
    // Download missing files.
  }

  let lastError;
  for (let attempt = 1; attempt <= options.retries; attempt += 1) {
    try {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payloadFor(config, request)),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      if (!contentType.includes('netcdf') && !contentType.includes('octet-stream')) {
        throw new Error(`Unexpected content type: ${contentType}`);
      }
      if (!response.body) throw new Error('Response body was empty');
      await rm(partial, { force: true });
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      const downloaded = await stat(partial);
      if (downloaded.size < 8) throw new Error('Downloaded file was empty');
      await rename(partial, file);
      return {
        ...request,
        status: 'downloaded',
        bytes: downloaded.size,
        sha256: await sha256(file),
        contentType,
        file,
      };
    } catch (error) {
      lastError = error;
      await rm(partial, { force: true });
      if (attempt < options.retries) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  return {
    ...request,
    status: 'failed',
    error: lastError instanceof Error ? lastError.message : String(lastError),
    file,
  };
}

const options = parseArguments(process.argv.slice(2));
const config = JSON.parse(await readFile(options.configFile, 'utf8'));
const requests = requestsFrom(config, options.families);
if (!requests.length) throw new Error('No requests matched the selected families');
await mkdir(options.cacheDirectory, { recursive: true });

const results = new Array(requests.length);
let cursor = 0;
async function worker() {
  while (cursor < requests.length) {
    const index = cursor;
    cursor += 1;
    const request = requests[index];
    process.stdout.write(
      `[${index + 1}/${requests.length}] ${request.family}/${request.variable}/${request.datasetType}/${request.month} ... `,
    );
    results[index] = await download(config, request, options);
    const result = results[index];
    console.log(result.status === 'failed'
      ? `FAILED: ${result.error}`
      : `${result.status} ${(result.bytes / 2 ** 20).toFixed(2)} MiB`);
  }
}

await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  endpoint: config.endpoint,
  bbox: config.bbox,
  selectedFamilies: options.families ? [...options.families] : null,
  totalRequests: results.length,
  successful: results.filter(({ status }) => status !== 'failed').length,
  failed: results.filter(({ status }) => status === 'failed').length,
  totalBytes: results.reduce((sum, { bytes = 0 }) => sum + bytes, 0),
  familyBytes: Object.fromEntries((config.families ?? []).map(({ id }) => [
    id,
    results
      .filter((result) => result.family === id)
      .reduce((sum, { bytes = 0 }) => sum + bytes, 0),
  ])),
  results: results.map((result) => ({
    ...result,
    file: path.relative(options.cacheDirectory, result.file),
  })),
};
const manifestFile = path.join(options.cacheDirectory, 'download-manifest.json');
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Completed: ${manifest.successful}/${manifest.totalRequests} successful`);
console.log(`Downloaded: ${(manifest.totalBytes / 2 ** 20).toFixed(2)} MiB`);
console.log(`Manifest: ${manifestFile}`);
if (manifest.failed > 0) process.exitCode = 1;
