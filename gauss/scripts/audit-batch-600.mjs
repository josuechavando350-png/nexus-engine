#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {resolve,join,relative,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {BATCH_600_ADDITIONS} from '../core/batch-600-additions.mjs';
import {verifyFile} from './verify-batch-600.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
async function walk(p){const out=[];for(const f of await readdir(p,{withFileTypes:true})){const full=join(p,f.name);if(f.isDirectory())out.push(...await walk(full));else if(f.isFile())out.push(full);else throw new Error(`nonregular source: ${full}`);}return out;}
const files=(await walk(join(ROOT,'gauss'))).sort();
const source=files.filter(f=>f.endsWith('.mjs'));
const importPattern=/(?:\bfrom\s+|\bimport\s*\()\s*['"]([^'"]+)['"]/gu;
for(const file of source){const text=await readFile(file,'utf8');for(const [,specifier]of text.matchAll(importPattern))assert(specifier.startsWith('node:')||specifier.startsWith('./')||specifier.startsWith('../'),`third-party import in ${file}: ${specifier}`);
 if(!file.endsWith('/audit-batch-600.mjs'))assert(!/\b(?:fetch\s*\(|process\.env\b|eval\s*\(|new\s+Function\s*\(|XMLHttpRequest\b|https?:\/\/)/u.test(text),`network, environment, or dynamic code token in ${file}`);
}
const previous=JSON.parse(await readFile(join(ROOT,'gauss/fixtures/prior-300-ids.json'),'utf8'));
assert.equal(previous.length,300);assert.equal(new Set(previous).size,300);
assert.equal(BATCH_600_ADDITIONS.length,100);assert.equal(new Set(BATCH_600_ADDITIONS.map(x=>x.execute)).size,100);
assert.equal(new Set([...previous,...BATCH_600_ADDITIONS.map(x=>x.id)]).size,400);
const verification=await verifyFile(join(ROOT,'execution-report.json'));
const hashes=Object.fromEntries(await Promise.all(files.map(async f=>[relative(ROOT,f),createHash('sha256').update(await readFile(f)).digest('hex')])));
const proof=await readFile(join(ROOT,'proof.tap'),'utf8');
assert.match(proof,/# pass 10\n/u);assert.match(proof,/# fail 0\n/u);
const audit={kind:'GAUSS_BATCH_600_OFFLINE_AUDIT',status:'LOCAL_PASS_NOT_INTEGRATED',node:process.version,previousNewIds:300,newOperators:100,uniqueExecutables:100,idCollisions:0,localTests:{passed:10,failed:0},replay:verification,staticScan:{mjsFiles:source.length,thirdPartyImports:0,flaggedNetworkEnvironmentOrDynamicCodeTokens:0,scope:'static token check of non-auditor modules; NOT independent security certification'},limitations:['Unmerged, not in Nexus main or the canonical registry','No Nexus/Quantum/WALLE CI or real-world performance certification','Algorithms are bounded by input size, not unlimited arbitrary precision','No independent external code/security audit'],sha256:hashes};
await writeFile(join(ROOT,'AUDIT.json'),JSON.stringify(audit,null,2)+'\n');console.log(JSON.stringify({status:audit.status,newOperators:100,priorUnique:300,collisions:0,testsPassed:10,reportSha256:verification.reportSha256,scannedModules:source.length}));
