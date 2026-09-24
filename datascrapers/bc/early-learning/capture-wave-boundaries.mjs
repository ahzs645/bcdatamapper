#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ShinyClient, initialInputs, verifyIdentity, polygonFeatures } from './shiny.mjs'
const args=process.argv.slice(2), option=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d
const capture=option('--capture',new Date().toISOString().slice(0,10))
if(!/^[a-zA-Z0-9_-]+$/.test(capture)) throw new Error('Invalid capture')
const root=join(dirname(fileURLToPath(import.meta.url)),'cache','captures',capture)
const regions=JSON.parse(readFileSync(join(root,'regions.json'),'utf8'))
const names=Object.fromEntries(regions.map(r=>[r.id,r.name]))
const target=join(root,'wave-boundaries'); mkdirSync(target,{recursive:true})
const failures=[]
for(const family of ['GEOSD','NH','HA','HSDA','LHA','CHSA','MCFD','SDA','LSA']) {
 let client
 try {
  for(const wave of (family==='CHSA'?[7,8,9]:[2,3,4,5,6,7,8,9])) {
   const file=join(target,`${family}-${wave}.geojson`)
   if(existsSync(file)) continue
   try {
    const id=`${family}_ALL`, inputs=initialInputs(id)
    inputs.caseSelector=`${id}_${wave}`
    let response
    if(!client) {client=new ShinyClient();response=await client.connect(inputs,{requirePolygons:true,polygonWave:wave})} else response=await client.update(inputs,{requirePolygons:true,polygonWave:wave})
    verifyIdentity(response.values,id,wave)
    const tooltipWaves=response.polygons.flatMap(p=>(p[6]??[])).flatMap(t=>[...String(t).matchAll(/Wave\s+(\d+)/g)].map(m=>Number(m[1])))
    if(!tooltipWaves.length || tooltipWaves.some(w=>w!==wave)) throw new Error('Map tooltip wave does not match requested wave')
    const features=response.polygons.flatMap(p=>polygonFeatures(p,family,names))
    if(!features.length) throw new Error('No labelled map polygons returned for this wave')
    const data={type:'FeatureCollection',metadata:{source:'https://dashboard.earlylearning.ubc.ca/',capture,displayedWave:wave,resolution:'Publisher display geometry; effective date unknown',redistributable:false},features}
    writeFileSync(file+'.tmp',JSON.stringify(data));renameSync(file+'.tmp',file)
    console.log(`${family} wave ${wave}: ${features.length} polygons`)
   } catch(e) {failures.push({family,wave,error:e.message});console.error(`${family}/${wave}: ${e.message}`);client?.close();client=null}
  }
 } finally {client?.close()}
}
writeFileSync(join(target,'capture.json'),JSON.stringify({capture,failures,complete:!failures.length}))
if(failures.length) process.exitCode=1
