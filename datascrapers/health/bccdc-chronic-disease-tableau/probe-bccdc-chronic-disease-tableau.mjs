import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output')
const WORKBOOK_URL =
  'https://public.tableau.com/views/BCChronicDiseaseDashboardv2/LeadingConditions?:embed=y&:showVizHome=no&:tabs=yes&:toolbar=yes&:language=en-US&publish=yes'
const USER_AGENT = 'Mozilla/5.0 PGMaps BCCDC Tableau probe'

const args = parseArgs(process.argv.slice(2))
const headed = args.headed === 'true'
const targetSheet = args.sheet ?? 'Data Table'
const waitMs = Number(args.wait ?? 8000)

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = 'true'
    } else {
      parsed[key] = next
      index += 1
    }
  }
  return parsed
}

function parseLengthPrefixedTableauPayload(text) {
  const chunks = []
  let index = 0
  while (index < text.length) {
    while (['\n', '\r', ' '].includes(text[index])) index += 1
    const semicolon = text.indexOf(';', index)
    if (semicolon === -1) break
    const length = Number(text.slice(index, semicolon))
    if (!Number.isFinite(length)) break
    const start = semicolon + 1
    const raw = text.slice(start, start + length)
    chunks.push(JSON.parse(raw))
    index = start + length
  }
  return chunks
}

function getZones(root) {
  return root?.applicationPresModel?.workbookPresModel?.dashboardPresModel?.zones ?? {}
}

function extractParameterControls(root) {
  const controls = []
  for (const [zoneId, zone] of Object.entries(getZones(root))) {
    const control = zone?.presModelHolder?.parameterControl
    if (!control) continue
    controls.push({
      zoneId,
      title: zone?.zoneCommon?.name ?? null,
      fieldCaption: control.fieldCaption ?? control.parameterCaption ?? null,
      formattedValue: control.formattedValue ?? null,
      unformattedValue: control.unformattedValue ?? null,
      valuesAliases: control.valuesAliases ?? null,
      formattedValues: control.formattedValues ?? null,
    })
  }
  return controls
}

function extractVisuals(root) {
  const visuals = []
  for (const [zoneId, zone] of Object.entries(getZones(root))) {
    const visual = zone?.presModelHolder?.visual
    if (!visual) continue
    const columns = visual.vizData?.paneColumnsData?.vizDataColumns ?? []
    visuals.push({
      zoneId,
      title: visual.visualTitle ?? zone?.zoneCommon?.name ?? null,
      totalMarks: visual.totalMarks ?? null,
      numberOfColumns: visual.numberOfColumns ?? null,
      hasRuntimeRenderInputDatastore: Boolean(visual.scene?.runtimeRenderInputDatastore),
      runtimeRenderInputDatastoreBytes: visual.scene?.runtimeRenderInputDatastore
        ? Math.floor(visual.scene.runtimeRenderInputDatastore.length / 2)
        : 0,
      columns: columns.map((column, index) => ({
        index,
        localBaseColumnName: column.localBaseColumnName ?? null,
        userFriendlyFieldCaption: column.userFriendlyFieldCaption ?? null,
        baseColumnName: column.baseColumnName ?? null,
        datasourceCaption: column.datasourceCaption ?? null,
        dataType: column.dataType ?? null,
        specialValueText: column.specialValueText ?? null,
      })),
    })
  }
  return visuals
}

async function extractRuntimeTextTable(page, visual) {
  const runtimeStore = visual?.scene?.runtimeRenderInputDatastore
  if (!runtimeStore) return null
  return page.evaluate((hexStore) => {
    const decoded = window.tab.JsHeapMarshaller.unmarshallHex(hexStore)
    const markSet = Object.values(decoded.PDMarks ?? {})[0]
    if (!markSet?.TextRunTable?.text_run || !markSet?.Encodings) return null

    const encodings = markSet.Encodings
    const textRuns = markSet.TextRunTable.text_run
    const xLabels = decoded.SceneMargin?.Styles?.XFullNodeLabels ?? []
    const yLabels = decoded.SceneMargin?.Styles?.YFullNodeLabels ?? []
    const regions = yLabels.filter((label) => label && !['Cases', 'Pop/Pop at Risk', 'Region Rate'].includes(label))
    const metrics = ['Cases', 'Pop/Pop at Risk', 'Region Rate']

    const cells = textRuns.map((text, index) => {
      const cellX = encodings.cell_x?.[index] ?? null
      const cellY = encodings.cell_y?.[index] ?? null
      const userPaneRow = encodings.user_pane_row?.[index] ?? null
      const metric = Number.isFinite(cellY) ? metrics[((cellY % metrics.length) + metrics.length) % metrics.length] : null
      const numericValue = typeof text === 'string' && text.trim()
        ? Number(text.replace(/,/g, ''))
        : null
      return {
        index,
        text,
        numericValue: Number.isFinite(numericValue) ? numericValue : null,
        fiscalYear: Number.isFinite(cellX) ? xLabels[cellX + 1] ?? null : null,
        region: Number.isFinite(userPaneRow) ? regions[userPaneRow] ?? null : null,
        metric,
        cellX,
        cellY,
        userPaneRow,
      }
    })

    return {
      headers: {
        xLabels,
        yLabels,
        regions,
        metrics,
      },
      cells,
      longRows: cells.map(({ index, text, numericValue, fiscalYear, region, metric }) => ({
        index,
        fiscalYear,
        region,
        metric,
        value: text,
        numericValue,
      })),
    }
  }, runtimeStore)
}

function csvEscape(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv(records) {
  const columns = ['index', 'fiscalYear', 'region', 'metric', 'value', 'numericValue']
  return [
    columns.join(','),
    ...records.map((record) => columns.map((column) => csvEscape(record[column])).join(',')),
  ].join('\n')
}

function summarizeStartPayload(payload) {
  return {
    workbookName: payload.workbookName,
    workbookRepoUrl: payload.workbook_repo_url,
    currentWorkbookId: payload.current_workbook_id,
    currentWorkbookLuid: payload.current_workbook_luid,
    currentViewId: payload.current_view_id,
    currentViewLuid: payload.current_view_luid,
    sheetId: payload.sheetId,
    sessionId: payload.sessionid,
    vizqlRoot: payload.vizql_root,
    visibleSheets: payload.visible_sheets,
    permissions: {
      allowExportData: payload.allow_export_data,
      allowViewUnderlying: payload.allow_view_underlying,
      allowSummary: payload.allow_summary,
      allowExportImage: payload.allow_export_image,
    },
    workbookLastPublishedAt: payload.workbookLastPublishedAt,
  }
}

async function probeExportCommands(page, sessionId) {
  const base = `https://public.tableau.com/vizql/w/BCChronicDiseaseDashboardv2/v/LeadingConditions/sessions/${sessionId}`
  const commands = [
    'commands/tabsrv/export-crosstab-to-csvserver',
    'commands/tabsrv/export-crosstab-server',
    'commands/tabsrv/export-data',
    'commands/tabdoc/get-summary-data',
    'commands/tabdoc/get-underlying-data',
  ]
  const attempts = []
  for (const command of commands) {
    attempts.push(
      await page.evaluate(
        async ({ baseUrl, commandName }) => {
          const form = new FormData()
          form.append('sheet', 'Table')
          form.append('worksheet', 'Table')
          form.append('dashboard', 'Data Table')
          const response = await fetch(`${baseUrl}/${commandName}`, {
            method: 'POST',
            body: form,
            credentials: 'include',
          })
          const text = await response.text().catch(() => '')
          return {
            command: commandName,
            status: response.status,
            contentType: response.headers.get('content-type'),
            bodyLength: text.length,
            bodyPrefix: text.slice(0, 500),
          }
        },
        { baseUrl: base, commandName: command },
      ),
    )
  }
  return attempts
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true })
  const browser = await chromium.launch({ headless: !headed })
  const context = await browser.newContext({
    viewport: { width: 970, height: 900 },
    userAgent: USER_AGENT,
  })
  const page = await context.newPage()
  const captures = []

  page.on('requestfinished', async (request) => {
    const url = request.url()
    if (!url.includes('/vizql/w/BCChronicDiseaseDashboardv2/')) return
    const response = await request.response().catch(() => null)
    let body = null
    if (response) {
      try {
        body = await response.text()
      } catch {
        body = null
      }
    }
    captures.push({
      status: response?.status() ?? null,
      method: request.method(),
      url,
      requestBody: request.postData(),
      responseHeaders: response?.headers() ?? {},
      bodyLength: body?.length ?? null,
      body,
    })
  })

  await page.goto(WORKBOOK_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(waitMs)
  const initialText = await page.locator('body').innerText()

  await page.getByText(targetSheet, { exact: true }).click({ timeout: 15_000 })
  await page.waitForTimeout(waitMs)
  const targetText = await page.locator('body').innerText()

  const startCapture = captures.find((capture) => capture.url.includes('/startSession/viewing'))
  const bootstrapCapture = captures.find((capture) => capture.url.includes('/bootstrapSession/sessions/'))
  const sheetCapture = captures.find((capture) => capture.url.includes('/commands/tabsrv/ensure-layout-for-sheet'))

  if (!startCapture?.body) throw new Error('Did not capture Tableau startSession response')
  if (!bootstrapCapture?.body) throw new Error('Did not capture Tableau bootstrapSession response')
  if (!sheetCapture?.body) throw new Error(`Did not capture Tableau sheet switch response for ${targetSheet}`)

  const startPayload = JSON.parse(startCapture.body)
  const bootstrapChunks = parseLengthPrefixedTableauPayload(bootstrapCapture.body)
  const sheetPayload = JSON.parse(sheetCapture.body)
  const bootstrapRoot = bootstrapChunks[0]?.worldUpdate
  const sheetRoot = sheetPayload.vqlCmdResponse?.layoutStatus
  const activeSessionId = sheetCapture.url.match(/\/sessions\/([^/]+)/)?.[1] ?? startPayload.sessionid
  const exportAttempts = await probeExportCommands(page, activeSessionId)
  const targetVisuals = extractVisuals(sheetRoot)
  const primaryTextTable = await extractRuntimeTextTable(
    page,
    sheetPayload.vqlCmdResponse?.layoutStatus?.applicationPresModel?.workbookPresModel?.dashboardPresModel?.zones?.['1']?.presModelHolder?.visual,
  )

  const summary = {
    generatedAt: new Date().toISOString(),
    source: WORKBOOK_URL,
    targetSheet,
    start: summarizeStartPayload(startPayload),
    requests: captures.map((capture) => ({
      status: capture.status,
      method: capture.method,
      url: capture.url,
      requestBodyLength: capture.requestBody?.length ?? null,
      bodyLength: capture.bodyLength,
    })),
    bootstrap: {
      chunkCount: bootstrapChunks.length,
      parameters: extractParameterControls(bootstrapRoot),
      visuals: extractVisuals(bootstrapRoot),
    },
    targetSheetResponse: {
      activeTab: sheetPayload.vqlCmdResponse?.layoutStatus?.active_tab ?? null,
      parameters: extractParameterControls(sheetRoot),
      visuals: targetVisuals,
      primaryTextTable: primaryTextTable
        ? {
            cellCount: primaryTextTable.cells.length,
            rowCount: primaryTextTable.longRows.length,
            regions: primaryTextTable.headers.regions,
            fiscalYears: primaryTextTable.headers.xLabels.filter(Boolean),
            metrics: primaryTextTable.headers.metrics,
          }
        : null,
    },
    exportAttempts,
    visibleText: {
      initial: initialText,
      targetSheet: targetText,
    },
    interpretation: [
      'Tableau Public export_data, view_underlying, and summary permissions are disabled.',
      'The VizQL bootstrap and sheet-switch endpoints are reproducible through a browser session.',
      'The Data Table sheet exposes visual column metadata through vizData.paneColumnsData.vizDataColumns.',
      'Rendered cell values are stored in Tableau runtimeRenderInputDatastore payloads, which need a decoder or DOM/canvas extraction step.',
    ],
  }

  await writeFile(path.join(OUTPUT_DIR, 'metadata.json'), `${JSON.stringify(summary, null, 2)}\n`)
  await writeFile(path.join(OUTPUT_DIR, 'startSession.json'), `${JSON.stringify(startPayload, null, 2)}\n`)
  await writeFile(path.join(OUTPUT_DIR, 'bootstrapSession.raw.txt'), bootstrapCapture.body)
  await writeFile(path.join(OUTPUT_DIR, 'bootstrapSession.parsed.json'), `${JSON.stringify(bootstrapChunks, null, 2)}\n`)
  await writeFile(path.join(OUTPUT_DIR, 'data-table-response.json'), `${JSON.stringify(sheetPayload, null, 2)}\n`)
  await writeFile(path.join(OUTPUT_DIR, 'data-table-visible-text.txt'), targetText)
  if (primaryTextTable) {
    await writeFile(path.join(OUTPUT_DIR, 'data-table-cells.json'), `${JSON.stringify(primaryTextTable, null, 2)}\n`)
    await writeFile(path.join(OUTPUT_DIR, 'data-table-long.csv'), `${toCsv(primaryTextTable.longRows)}\n`)
  }

  await browser.close()
  console.log(`BCCDC Tableau: wrote ${path.relative(process.cwd(), OUTPUT_DIR)}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
