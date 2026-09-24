#!/usr/bin/env node
// The dashboard omits an intermediate CA. Verify and supply that intermediate;
// do not disable HTTPS certificate verification or change system trust settings.
import { X509Certificate, createHash } from 'node:crypto'
import { rootCertificates } from 'node:tls'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const der=execFileSync('curl',['-fsSL','--max-time','30','http://crt.sectigo.com/EntrustOVTLSIssuingECCCA2.crt'])
const expected='ca9ad33c5effd39fb72291230bb157b4f805d166d5278245289f4606a4b299d7'
if(createHash('sha256').update(der).digest('hex')!==expected) throw new Error('Issuer fingerprint changed; verify the publisher certificate chain before updating the pin.')
const issuer=new X509Certificate(der)
const root=rootCertificates.map(p=>new X509Certificate(p)).find(r=>r.subject===issuer.issuer && issuer.verify(r.publicKey))
if(!root || !issuer.ca || Date.now()<Date.parse(issuer.validFrom) || Date.now()>Date.parse(issuer.validTo)) throw new Error('Issuer is not currently valid under a bundled trusted root')
const path=join(dirname(fileURLToPath(import.meta.url)),'cache/tls/issuer.pem')
mkdirSync(dirname(path),{recursive:true});writeFileSync(path,issuer.toString())
console.log(path)
