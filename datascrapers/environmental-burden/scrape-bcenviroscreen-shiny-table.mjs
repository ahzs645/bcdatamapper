#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const APP_URL = 'https://planetaryhealth.shinyapps.io/BC_Enviro_Screen/';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(SCRIPT_DIR, 'output/bc-enviro-screen/official-shiny-table');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace('pm2.5', 'pm25')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function readMapRows(page) {
  return page.evaluate(() => {
    const widget = window.HTMLWidgets?.find?.('#map');
    const map = widget?.getMap?.();
    if (!map) return [];

    const rows = [];
    map.eachLayer((layer) => {
      const content = layer.getTooltip?.()?.getContent?.();
      if (typeof content !== 'string') return;

      const match = content.match(/^(.*?):\s*([-+]?\d+(?:\.\d+)?)(?:\s*(.*))?$/);
      if (!match) return;

      rows.push({
        lha_name: match[1],
        value: Number(match[2]),
        unit_or_range: (match[3] ?? '').trim() || null,
        fill_color: layer.options?.fillColor ?? null,
        tooltip: content,
      });
    });
    return rows;
  });
}

async function selectIndicator(page, value) {
  await page.evaluate((indicator) => {
    const select = document.querySelector('#filter_ind');
    select.value = indicator;
    if (window.jQuery) {
      window.jQuery(select).selectpicker?.('val', indicator);
      window.jQuery(select).trigger('change');
    }
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function waitForRows(page, previousSignature) {
  let rows = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await sleep(250);
    rows = await readMapRows(page);
    const signature = rows.map((row) => row.tooltip).join('|');
    if (rows.length === 89 && signature && signature !== previousSignature) {
      return { rows, signature };
    }
  }
  return { rows, signature: rows.map((row) => row.tooltip).join('|') };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForSelector('#filter_ind', { timeout: 120000 });
    await page.waitForFunction(() => window.HTMLWidgets?.find?.('#map')?.getMap?.(), null, { timeout: 120000 });

    const indicators = await page.evaluate(() => Array.from(document.querySelectorAll('#filter_ind option')).map((option) => ({
      value: option.value,
      label: option.textContent.trim(),
    })));

    const byIndicator = {};
    const diagnostics = [];
    let signature = '';

    for (const indicator of indicators) {
      await selectIndicator(page, indicator.value);
      const captured = await waitForRows(page, signature);
      signature = captured.signature;
      byIndicator[indicator.label] = captured.rows;
      diagnostics.push({
        indicator: indicator.label,
        app_value: indicator.value,
        rows: captured.rows.length,
        prince_george: captured.rows.find((row) => row.lha_name === 'Prince George')?.value ?? null,
      });
      console.log(`${indicator.label}: ${captured.rows.length} rows`);
    }

    const lhaNames = [...new Set(Object.values(byIndicator).flatMap((rows) => rows.map((row) => row.lha_name)))];
    const wideRows = lhaNames.map((lhaName) => {
      const row = { lha_name: lhaName };
      for (const indicator of indicators) {
        const found = byIndicator[indicator.label].find((item) => item.lha_name === lhaName);
        row[slugify(indicator.label)] = found?.value ?? null;
      }
      return row;
    });

    const metadata = {
      source_url: APP_URL,
      captured_at: new Date().toISOString(),
      note: 'Values are the displayed BC EnviroScreen Shiny app map values parsed from Leaflet polygon tooltips for every indicator and LHA.',
      indicators,
      diagnostics,
    };

    await fs.writeFile(path.join(OUT_DIR, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    await fs.writeFile(path.join(OUT_DIR, 'indicator-long.json'), `${JSON.stringify(byIndicator, null, 2)}\n`);
    await fs.writeFile(path.join(OUT_DIR, 'lha-indicators.json'), `${JSON.stringify(wideRows, null, 2)}\n`);

    const columns = ['lha_name', ...indicators.map((indicator) => slugify(indicator.label))];
    const csv = [
      columns.join(','),
      ...wideRows.map((row) => columns.map((column) => csvEscape(row[column])).join(',')),
    ].join('\n');
    await fs.writeFile(path.join(OUT_DIR, 'lha-indicators.csv'), `${csv}\n`);

    console.log(`Wrote ${wideRows.length} LHA rows and ${indicators.length} indicators to ${OUT_DIR}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
