#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir,writeFile,lstat} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NEW_200_ADDITIONS,BATCH_900_ADDITIONS,BATCH_1000_ADDITIONS} from '../core/batch-1000-additions.mjs';
import {verifyFile} from './verify-batch-1000.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const rel=p=>relative(root,p).replaceAll('\\','/');
async function files(dir){let out=[];for(const name of await readdir(dir)){const p=join(dir,name),st=await lstat(p);if(st.isSymbolicLink())throw new Error('package contains symlink:'+rel(p));if(st.isDirectory())out.push(...await files(p));else if(st.isFile())out.push(p);}return out;}
export async function audit(){
 const prior=JSON.parse(await readFile(join(root,'gauss/fixtures/prior-600-ids.json'),'utf8'));
 const fixture=JSON.parse(await readFile(join(root,'gauss/fixtures/batch-801-1000-problem.json'),'utf8'));
 assert.equal(prior.length,600);assert.equal(new Set(prior).size,600);
 assert.equal(BATCH_900_ADDITIONS.length,100);assert.equal(BATCH_1000_ADDITIONS.length,100);
 assert.equal(NEW_200_ADDITIONS.length,200);assert.equal(new Set(NEW_200_ADDITIONS.map(x=>x.id)).size,200);
 assert.equal(new Set(NEW_200_ADDITIONS.map(x=>x.execute)).size,200);
 assert.equal(new Set([...prior,...NEW_200_ADDITIONS.map(x=>x.id)]).size,800);
 assert.deepEqual(fixture.tasks.map(t=>t.layerId),NEW_200_ADDITIONS.map(x=>x.id));
 for(let i=0;i<200;i++)assert.deepEqual(fixture.tasks[i].input,NEW_200_ADDITIONS[i].input);
 const replay=await verifyFile(join(root,'execution-report.json'));
 const sourceFiles=[join(root,'README.md'),...await files(join(root,'gauss'))].sort();
 const sha={},imports=[],violations=[];for(const file of sourceFiles){const text=await readFile(file,'utf8');sha[rel(file)]=sha256(text);if(!file.endsWith('.mjs'))continue;
  for(const m of text.matchAll(/\b(?:import|export)\s+(?:[^;'"`]+?\s+from\s+)?['"]([^'"]+)['"]/gu)){const spec=m[1];if(!spec.startsWith('./')&&!spec.startsWith('../')&&!spec.startsWith('node:'))imports.push({file:rel(file),module:spec});}
  if(/\bimport\s*\(/u.test(text)||/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/u.test(text)||/\bprocess\.env\b/u.test(text)||/\brequire\s*\(/u.test(text))violations.push(rel(file));
 }
 assert.deepEqual(imports,[],'third-party or nonlocal import');assert.deepEqual(violations,[],'dynamic imports, network or env access');
 const sourceDigest=sha256(Object.entries(sha).map(([k,v])=>`${k}:${v}`).join('\n'));
 const result={kind:'GAUSS_OFFLINE_801_1000_AUDIT',status:'LOCAL_PASS_NOT_INTEGRATED',runtime:process.version,previousNewOperatorIds:600,newOperators:200,batch900:100,batch1000:100,uniqueExecutables:200,allDistinctOfflineIds:800,collisionsWithPriorPackages:0,localReplay:replay,staticScan:{mjsFiles:sourceFiles.filter(f=>f.endsWith('.mjs')).length,thirdPartyImports:0,flaggedKernelTokens:0,scope:'static local scan only; not an independent security audit'},sourceDigest,sha256:sha,limitations:['No Nexus main integration, Quantum/WALLE certification, or whole-repo CI','No independent formal proof of all 200 mathematical contracts','Some algorithms are bounded enumerations; codebook entropy and redundancy use floating-point','No benchmark of production performance or external independent security review']};
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){if(process.argv.length>3)throw new Error('usage: node audit-batch-1000.mjs [AUDIT.json]');const result=await audit();if(process.argv[2])await writeFile(resolve(process.argv[2]),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,newOperators:result.newOperators,allDistinctOfflineIds:result.allDistinctOfflineIds,reportSha256:result.localReplay.reportSha256,sourceDigest:result.sourceDigest}));}
