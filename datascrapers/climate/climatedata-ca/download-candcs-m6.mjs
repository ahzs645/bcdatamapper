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
    cacheDirectory: path.join(scraperDirectory, 'cache'),
    configFile: path.join(scraperDirectory, 'products.json'),
    concurrency: 3,
    retries: 3,
    timeoutMs: 300_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--cache-dir' && value) options.cacheDirectory = path.resolve(value);
    else if (argument === '--config' && value) options.configFile = path.resolve(value);
    else if (argument === '--concurrency' && value) options.concurrency = Number(value);
    else if (argument === '--retries' && value) options.retries = Number(value);
    else if (argument === '--timeout-ms' && value) options.timeoutMs = Number(value);
    else if (argument === '--help') {
      console.log(`Usage: node ${path.basename(import.meta.url)} [options]

Options:
  --cache-dir PATH    Raw downloads and manifest directory
  --config PATH       Product configuration JSON
  --concurrency N     Simultaneous downloads (default: 3)
  --retries N         Attempts per file (default: 3)
  --timeout-ms N      Timeout per attempt (default: 300000)`);
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
    if (argument !== '--help') index += 1;
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

function requestsFrom(config) {
  const requests = [];
  for (const group of config.groups ?? []) {
    for (const variable of group.variables ?? []) {
      requests.push({ variable, month: group.month, group: group.id });
    }
  }
  return requests;
}

function payloadFor(config, request) {
  return { ...config.request, month: request.month, var: request.variable };
}

async function download(config, request, options, rawDirectory) {
  const file = path.join(rawDirectory, `${request.variable}.nc`);
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
    // The requested file is missing and will be downloaded.
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
const rawDirectory = path.join(options.cacheDirectory, 'raw');
const requests = requestsFrom(config);
await mkdir(rawDirectory, { recursive: true });

const results = new Array(requests.length);
let cursor = 0;
async function worker() {
  while (cursor < requests.length) {
    const index = cursor;
    cursor += 1;
    const request = requests[index];
    process.stdout.write(`[${index + 1}/${requests.length}] ${request.variable} ... `);
    results[index] = await download(config, request, options, rawDirectory);
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
  ...config.request,
  config: path.relative(options.cacheDirectory, options.configFile),
  totalRequests: results.length,
  successful: results.filter(({ status }) => status !== 'failed').length,
  failed: results.filter(({ status }) => status === 'failed').length,
  totalBytes: results.reduce((sum, { bytes = 0 }) => sum + bytes, 0),
  results: results.map((result) => ({
    ...result,
    file: path.relative(options.cacheDirectory, result.file),
  })),
};

const manifestFile = path.join(options.cacheDirectory, 'download-manifest.json');
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Completed: ${manifest.successful}/${manifest.totalRequests} successful`);
console.log(`Downloaded: ${(manifest.totalBytes / 2 ** 30).toFixed(2)} GiB`);
console.log(`Manifest: ${manifestFile}`);
if (manifest.failed > 0) process.exitCode = 1;
