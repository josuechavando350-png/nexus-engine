#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NEW_200_ADDITIONS,BATCH_700_ADDITIONS,BATCH_800_ADDITIONS} from '../core/batch-800-additions.mjs';
import {executeOffline} from './batch-800-runner.mjs';
import {verify} from './verify-batch-800.mjs';
const base=resolve(fileURLToPath(new URL('../..',import.meta.url)));
async function walk(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())out.push(...await walk(path));else if(e.isFile())out.push(path);else throw new Error(`unapproved filesystem entry: ${path}`);}return out;}
export async function audit(){const old=JSON.parse(await readFile(join(base,'gauss/fixtures/prior-400-ids.json'),'utf8'));
 assert.equal(old.length,400);assert.equal(new Set(old).size,400);
 assert.equal(BATCH_700_ADDITIONS.length,100);assert.equal(BATCH_800_ADDITIONS.length,100);
 assert.equal(NEW_200_ADDITIONS.length,200);assert.equal(new Set(NEW_200_ADDITIONS.map(d=>d.id)).size,200);
 assert.equal(new Set(NEW_200_ADDITIONS.map(d=>d.execute)).size,200);
 assert.equal(new Set([...old,...NEW_200_ADDITIONS.map(d=>d.id)]).size,600);
 const sources=(await walk(join(base,'gauss'))).filter(p=>p.endsWith('.mjs'));
 const badImports=[],badTokens=[];
 for(const path of sources){const text=await readFile(path,'utf8');for(const match of text.matchAll(/\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g)){const spec=match[1];if(!spec.startsWith('./')&&!spec.startsWith('../')&&!spec.startsWith('node:'))badImports.push({path:relative(base,path),specifier:spec});}
 if(path.includes('/layers/')||path.endsWith('/batch-800-additions.mjs')){for(const re of [/\b(?:fetch|XMLHttpRequest|WebSocket|eval)\s*\(/g,/\bprocess\.env\b/g,/\b(?:https?|net|tls|child_process)\s*[:.]\s*\/\//g])if(re.test(text))badTokens.push({path:relative(base,path),pattern:String(re)});}}
 assert.deepEqual(badImports,[],'only local modules and node:* allowed');assert.deepEqual(badTokens,[],'network, environment and dynamic-code tokens forbidden in calculation kernels');
 const report=await executeOffline(),proof=await verify(report);
 const files=(await walk(join(base,'gauss'))).sort();
 const sha256=Object.fromEntries(await Promise.all(files.map(async p=>[relative(base,p),createHash('sha256').update(await readFile(p)).digest('hex')])));
 return {kind:'GAUSS_OFFLINE_601_800_AUDIT',status:'LOCAL_PASS_NOT_INTEGRATED',runtime:process.version,previousNewOperatorIds:400,newOperators:200,batch700:100,batch800:100,uniqueExecutables:200,allDistinctOfflineIds:600,collisionsWithPriorPackages:0,localReplay:proof,staticScan:{mjsFiles:sources.length,thirdPartyImports:badImports.length,flaggedKernelTokens:badTokens.length,scope:'static check, not a complete independent security review'},sha256,limitations:['No Nexus main integration, Quantum/WALLE CI, or deployment','Not a comprehensive third-party code audit','Some algorithms are bounded exact enumerations; entropy values are floating-point','No verified client outcome or hardware quantum claim']};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const result=await audit();if(process.argv.length>3)throw new Error('usage: node audit-batch-800.mjs [AUDIT.json]');if(process.argv[2])await writeFile(resolve(process.argv[2]),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,newOperators:result.newOperators,uniqueExecutables:result.uniqueExecutables,allDistinctOfflineIds:result.allDistinctOfflineIds,collisionsWithPriorPackages:result.collisionsWithPriorPackages,reportSha256:result.localReplay.reportSha256}));}
