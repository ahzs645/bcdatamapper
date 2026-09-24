import { randomBytes } from 'node:crypto'

// Public Shiny/SockJS data client. Never evaluates server-supplied JavaScript.
export class ShinyClient {
  constructor() { this.sequence = 0; this.values = {}; this.pending = null; this.disabledCases = new Set() }
  async connect(inputs, options) {
    const nonce = randomBytes(12).toString('hex')
    this.requestedCase = inputs.caseSelector
    this.socket = new WebSocket(`wss://dashboard.earlylearning.ubc.ca/__sockjs__/n=${nonce}/000/${nonce}/websocket`)
    const result = this.expect(options)
    this.socket.onmessage = ({ data }) => {
      if (data === 'o') { this.send('o|'); this.send('m|' + JSON.stringify({ method: 'init', data: inputs })); return }
      if (!data.startsWith('a')) return
      for (const frame of JSON.parse(data.slice(1))) {
        const match = frame.match(/^([0-9A-F]+)#0\|m\|([\s\S]*)$/)
        if (!match) continue
        this.socket.send(JSON.stringify([`ACK ${(parseInt(match[1], 16) + 1).toString(16).toUpperCase()}`]))
        const message = JSON.parse(match[2])
        // Read the publisher's disabled-wave declarations as data. Never execute JS.
        const source = message.custom?.['shinyjs-runjs']?.code ?? ''
        for (const m of source.matchAll(/\[name=caseSelector\]\[value=([A-Za-z0-9_]+)\][\s\S]{0,30}prop\('disabled', true\)/g)) this.disabledCases.add(m[1])
        if (this.disabledCases.has(this.requestedCase) && this.pending) {
          const error = new Error(`Publisher disables ${this.requestedCase}`)
          error.code = 'UNAVAILABLE_CASE'; error.disabledCases = [...this.disabledCases]
          this.fail(error)
        }
        for (const id of Object.keys(message.errors ?? {})) this.values[id] = null
        if (message.values) Object.assign(this.values, message.values)
        if (this.pending) {
          if (message.values) Object.assign(this.pending.changed, message.values)
          if (message.errors) Object.assign(this.pending.errors, message.errors)
          for (const call of message.custom?.['leaflet-calls']?.calls ?? []) {
            if (message.custom['leaflet-calls'].id === 'scalesMap' && call.method === 'addPolygons') {
              const waves = (call.args[6] ?? []).flatMap(t => [...String(t).matchAll(/Wave\s+(\d+)/g)].map(m => Number(m[1])))
              if (!this.pending.polygonWave || (waves.length && waves.every(w => w === this.pending.polygonWave))) this.pending.polygons.push(call.args)
            }
          }
          if (message.values || message.errors || message.custom?.['leaflet-calls']) this.settle()
        }
      }
    }
    this.socket.onerror = () => this.fail(new Error('Shiny connection failed. If the server omits its intermediate certificate, supply NODE_EXTRA_CA_CERTS with the verified issuer PEM; do not disable TLS verification.'))
    this.socket.onclose = () => this.fail(new Error('Shiny connection closed'))
    return result
  }
  send(body) { this.socket.send(JSON.stringify([`${(this.sequence++).toString(16).toUpperCase()}#0|${body}`])) }
  expect({ requirePolygons = false, polygonWave = null } = {}) {
    if (this.pending) throw new Error('Only one Shiny request may be in flight')
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, changed: {}, polygons: [], errors: {}, requirePolygons, polygonWave, timer: setTimeout(() => this.fail(new Error('Shiny response timed out')), 45000) }
    })
  }
  settle() {
    clearTimeout(this.quiet)
    // Values and deferred Leaflet calls are sent separately after Shiny's idle message.
    this.quiet = setTimeout(() => {
      const p = this.pending
      if (!p || (!Object.keys(p.changed).length && !Object.keys(p.errors).length)) return
      if (p.requirePolygons && !p.polygons.length && !p.errors.scalesMap) return
      clearTimeout(p.timer); this.pending = null
      p.resolve({ values: structuredClone(this.values), changed: p.changed, polygons: p.polygons, errors: p.errors })
    }, 300)
  }
  async update(data, options) { this.requestedCase = data.caseSelector ?? this.requestedCase; const result = this.expect(options); this.send('m|' + JSON.stringify({ method: 'update', data })); return result }
  fail(error) { if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null } }
  close() { clearTimeout(this.quiet); this.socket?.close() }
}

export function initialInputs(region, scale = 'overall', wave = 9) {
  const boundary = region.split('_')[0]
  const data = { boundarySelector: boundary, regionSelector: region, caseSelector: `${region}_${wave}`, scalesScaleSelector: scale, subscalesScaleSelector: 'social', exploreScaleSelector: 'overall', scalesTrendChartSelector: 'overall_vulnerability', exploreChartSelector: 'Vulnerability', searchInput: '', 'introjs-dontShowAgain': true, '.clientdata_url_protocol': 'https:', '.clientdata_url_hostname': 'dashboard.earlylearning.ubc.ca', '.clientdata_url_pathname': '/', '.clientdata_url_search': '', '.clientdata_pixelratio': 1 }
  for (const id of ['scalesMap', 'scalesTrendsChart', 'scalesOutcomesChart', 'scalesHeadline', 'breadcrumb', 'titleWave', 'demoTable', 'demoParticipationTable', 'subscaleTrendChartTop', 'subscaleTrendChartBottom', 'scalesCriticalDifferenceExplanation', 'subscalesCriticalDifferenceExplanation']) {
    data[`.clientdata_output_${id}_hidden`] = false
    data[`.clientdata_output_${id}_width`] = 800
    data[`.clientdata_output_${id}_height`] = 400
  }
  // Each family's ALL selection supplies its complete display geometry once.
  // Suspend the map for area detail requests to avoid repeatedly transferring it.
  data['.clientdata_output_scalesMap_hidden'] = !region.endsWith('_ALL')
  return data
}
export function plain(value) {
  return String(value?.html ?? value ?? '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}
export function charts(value) {
  return (value?.x?.data ?? []).filter(t => Array.isArray(t.x) && Array.isArray(t.y)).map(t => ({ name: t.name ?? '', x: t.x, y: t.y, counts: t.customdata ?? t.hovertext, meta: t.meta, hover: t.hovertemplate, lineColor: t.line?.color }))
}
export function verifyIdentity(values, region, wave = 9) {
  const html = values.breadcrumb?.html ?? ''
  const ids = [...html.matchAll(/switch_case_prevent_default\(event, ['"]([^'"]+)['"]\)/g)].map(m => m[1])
  if (ids.at(-1) !== `${region}_${wave}` || Number(values.titleWave) !== wave) throw new Error(`Response identity mismatch: requested ${region}_${wave}; got ${ids.at(-1)} / ${values.titleWave}`)
}
export function polygonFeatures(args, boundary, names = {}) {
  const [shapes, ids] = args
  if (!Array.isArray(shapes) || !Array.isArray(ids) || shapes.length !== ids.length) throw new Error('Unexpected Leaflet polygon payload')
  return ids.flatMap((id, i) => {
    if (!id?.startsWith(`${boundary}_`)) return []
    const polygons = shapes[i].map(poly => poly.map(ring => {
      if (!Array.isArray(ring.lng) || ring.lng.length !== ring.lat?.length) throw new Error(`Invalid ring for ${id}`)
      const points = ring.lng.map((lng, j) => [lng, ring.lat[j]])
      if (points.some(p => !p.every(Number.isFinite)) || points.length < 3) throw new Error(`Invalid coordinates for ${id}`)
      if (JSON.stringify(points[0]) !== JSON.stringify(points.at(-1))) points.push(points[0])
      return points
    }))
    return [{ type: 'Feature', id, properties: { regionId: id, regionCode: id.slice(boundary.length + 1), boundaryCode: boundary, regionName: names[id] ?? id }, geometry: { type: 'MultiPolygon', coordinates: polygons } }]
  })
}
