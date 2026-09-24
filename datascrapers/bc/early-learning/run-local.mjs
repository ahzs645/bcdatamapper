#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
const root=dirname(fileURLToPath(import.meta.url)), args=process.argv.slice(2)
if (!existsSync(join(root,'../early-learning-boundaries/cache/EDI_data_library_wave_2_to_8.xlsx'))) {
 console.error('Missing historical workbook: run npm run early-learning-boundaries:sync first. See README.md.')
 process.exit(1)
}
const option=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback
const capture=option('--capture',new Date().toISOString().slice(0,10))
const workers=option('--workers','1')
const steps=[['node','prepare-tls.mjs'],['python3','capture-current-boundaries.py'],['node','capture-dashboard.mjs'],['node','capture-wave-boundaries.mjs'],['node','capture-dashboard.mjs'],['uv','crosswalk.py'],['python3','normalize.py'],['python3','validate.py']]
const failures=[]
for(const [runtime,script] of steps) {
 const params=['prepare-tls.mjs','validate.py'].includes(script)?[]:['--capture',capture]
 if(script==='capture-dashboard.mjs')params.push('--workers',workers)
 console.log(`\n${script}`)
 // Shapely is pinned in requirements-crosswalk.txt; the other Python steps are standard library only.
 const command=runtime==='uv'?['run','--python','3.11','--with-requirements',join(root,'requirements-crosswalk.txt'),'python',join(root,script),...params]:[join(root,script),...params]
 const result=spawnSync(runtime,command,{stdio:'inherit',env:script==='prepare-tls.mjs'?process.env:{...process.env,NODE_EXTRA_CA_CERTS:join(root,'cache/tls/issuer.pem')}})
 if(result.error || result.status!==0) {
  failures.push(script)
  if(script==='prepare-tls.mjs')break
 }
}
if(failures.length){console.error('Incomplete steps: '+failures.join(', '));process.exitCode=1}
