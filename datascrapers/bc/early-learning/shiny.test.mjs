import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyIdentity, polygonFeatures, charts } from './shiny.mjs'
test('rejects a stale area or wave despite selector changes', () => {
 const values = {breadcrumb:{html:"onclick=\"switch_case_prevent_default(event, 'CHSA_2210_9')\""}, titleWave:9}
 verifyIdentity(values,'CHSA_2210')
 assert.throws(() => verifyIdentity(values,'CHSA_2211'), /mismatch/)
 assert.throws(() => verifyIdentity({...values,titleWave:8},'CHSA_2210'), /mismatch/)
})
test('preserves rings and excludes unnamed or wrong-family geometry', () => {
 const shape = [[{lng:[-123,-122,-122], lat:[49,49,50]}]]
 const features = polygonFeatures([[shape,shape,shape],['CHSA_2210',null,'LHA_221']],'CHSA',{'CHSA_2210':'New Westminster'})
 assert.equal(features.length,1)
 assert.deepEqual(features[0].geometry.coordinates[0][0],[[-123,49],[-122,49],[-122,50],[-123,49]])
 assert.throws(() => polygonFeatures([[[[{lng:[0,1,2],lat:[0]}]]],['CHSA_1']],'CHSA'),/ring/)
})
test('keeps negative standardized scores and nulls without coercion', () => {
 const series = charts({x:{data:[{name:'Score',x:[7,8,9],y:[0,-0.2,null],customdata:[null,0,5]}]}})
 assert.deepEqual(series[0].y,[0,-0.2,null])
 assert.deepEqual(series[0].counts,[null,0,5])
})
test('waits for geometry whose own tooltip matches the requested wave', async () => {
 const Original=globalThis.WebSocket
 class FakeSocket { send() {} close() {} }
 globalThis.WebSocket=FakeSocket
 const {ShinyClient}=await import('./shiny.mjs')
 const client=new ShinyClient()
 try {
  const result=client.connect({}, {requirePolygons:true,polygonWave:2})
  const deliver=(message)=>client.socket.onmessage({data:'a'+JSON.stringify(['0#0|m|'+JSON.stringify(message)])})
  const polygon=(wave)=>({custom:{'leaflet-calls':{id:'scalesMap',calls:[{method:'addPolygons',args:[[],[],null,null,null,null,[`Area - Wave ${wave}`]]}]}}})
  deliver({values:{titleWave:2}})
  deliver(polygon(9))
  assert.equal(client.pending.polygons.length,0)
  deliver(polygon(2))
  const response=await result
  assert.equal(response.polygons.length,1)
  assert.match(response.polygons[0][6][0],/Wave 2/)
 } finally {client.close();globalThis.WebSocket=Original}
})
test('recognizes a publisher-disabled wave without evaluating its JavaScript', async () => {
 const Original=globalThis.WebSocket
 globalThis.WebSocket=class {send(){} close(){}}
 const {ShinyClient}=await import('./shiny.mjs'), client=new ShinyClient()
 try {
  const result=client.connect({caseSelector:'GEOSD_87_9'})
  const rejected=assert.rejects(result,e=>e.code==='UNAVAILABLE_CASE' && e.disabledCases.includes('GEOSD_87_9'))
  const code="setTimeout(function() { $('input[type=radio][name=caseSelector][value=GEOSD_87_9]').prop('disabled', true).css('opacity', '.2'); }, 100);"
  client.socket.onmessage({data:'a'+JSON.stringify(['0#0|m|'+JSON.stringify({custom:{'shinyjs-runjs':{code}}})])})
  await rejected
 } finally {client.close();globalThis.WebSocket=Original}
})
