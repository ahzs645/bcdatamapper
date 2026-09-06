/** Optional integration test, using PGMaps' Playwright dependency and Chrome.
 * node browser-test.mjs https://.../manifest.json [screenshot.png]
 */
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
const input=process.argv[2]??'https://data.map.ahmad.sh/climate/bc-climate-u6/latest.json';
let manifestUrl=input,manifest=await fetch(input).then(r=>{if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json()});
if(manifest.manifest){manifestUrl=new URL(manifest.manifest,input).href;manifest=await fetch(manifestUrl).then(r=>r.json());}
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 // Force metadata to arrive after the first view-state callback: regression
 // test for controls/viewport firing before product.bands exists.
 await page.route('**/products/*.json',async route=>{await new Promise(resolve=>setTimeout(resolve,700));await route.continue()});
 await page.goto(new URL('preview.html',manifestUrl).href);
 async function complete(id,season='annual'){
   const p=await fetch(new URL(manifest.products.find(p=>p.id===id).path,manifestUrl)).then(r=>r.json());
   const band=p.bands.find(b=>b.horizon==='2071-2100'&&b.percentile==='p50'&&b.measure==='absolute'&&b.season===season);
   const expected=`${band.validCells.toLocaleString('en-US')} cells · ${p.tiles.length} visible blocks`;
   await page.waitForFunction(expected=>document.querySelector('#status')?.textContent===expected,expected,{timeout:60000});
   console.log(id,season,await page.locator('#status').innerText());
 }
 await complete('txgt_29');
 if(process.argv[3])await page.screenshot({path:process.argv[3]});
 await page.selectOption('#product','prcptot_seasonal');
 await page.waitForFunction(()=>document.querySelector('#season').options.length===4);
 await page.selectOption('#season','winter');
 await complete('prcptot_seasonal','winter');
 await page.selectOption('#product','PAS');
 await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Zoom'));
 assert.equal(await page.locator('#percentile').isDisabled(),true);
 // Zoom at a BC interior location; the fine snow grid should then load.
 await page.mouse.move(720,500);
 // Deck.gl clamps an individual wheel event's zoom step; use several events.
 for(let i=0;i<4;i++){await page.mouse.wheel(0,-600);await page.waitForTimeout(250);}
 await page.waitForFunction(()=>/^[1-9][\d,]* cells/.test(document.querySelector('#status').textContent),null,{timeout:60000});
 console.log('PAS',await page.locator('#status').innerText());
 assert.deepEqual(errors,[],'No browser exceptions');
 console.log('Browser integration passed');
}finally{await browser.close()}
