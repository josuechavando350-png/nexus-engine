#!/usr/bin/env node
// Offline file integrity and static-dependency report; reads package files only.
import {readdir,readFile,stat} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {BATCH_400_ADDITIONS} from '../core/batch-400-additions.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sha256=x=>createHash('sha256').update(x).digest('hex');
async function list(path){let files=[];for(const e of await readdir(path,{withFileTypes:true})){const name=join(path,e.name);if(e.isDirectory())files.push(...await list(name));else if(e.isFile())files.push(name);else throw new Error(`unsafe file type: ${name}`);}return files;}
const paths=(await list(root)).filter(x=>!['AUDIT.json','execution-report.json','benchmark.json','proof.tap'].includes(relative(root,x))).sort();
const files={};let thirdPartyImports=0,externalApiTokens=0,secretTokens=0;
for(const path of paths){const rel=relative(root,path),contents=await readFile(path);files[rel]={bytes:contents.length,sha256:sha256(contents)};
 if(!path.endsWith('.mjs'))continue;
 const text=contents.toString('utf8');
 for(const line of text.split('\n'))if(line.trimStart().startsWith('import ')){const match=line.match(/from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/u);if(match){const spec=match[1]??match[2];if(!spec.startsWith('.')&&!spec.startsWith('node:'))thirdPartyImports++;}}
 for(const match of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)/gu))if(!match[1].startsWith('.')&&!match[1].startsWith('node:'))thirdPartyImports++;
 if(!rel.endsWith('audit-batch-400.mjs')&&/\b(?:fetch\s*\(|XMLHttpRequest|https?\s*\.\s*(?:get|request)\s*\(|WebSocket\s*\()/u.test(text))externalApiTokens++;
 if(/\b(?:process\.env|api[_-]?key|secret[_-]?key|access[_-]?token)\b/iu.test(text))secretTokens++;
}
const prior=JSON.parse(await readFile(join(root,'gauss/fixtures/prior-batch-id-manifest.json')));
const fixture=JSON.parse(await readFile(join(root,'gauss/fixtures/batch-400-problem.json')));
const proof=await readFile(join(root,'proof.tap'),'utf8'),report=JSON.parse(await readFile(join(root,'execution-report.json')));
const benchmark=JSON.parse(await readFile(join(root,'benchmark.json')));
if(thirdPartyImports||externalApiTokens||secretTokens)throw new Error(`unexpected external dependency/API/secret reference: imports=${thirdPartyImports}, network=${externalApiTokens}, secrets=${secretTokens}`);
if(prior.ids.length!==100||new Set(prior.ids).size!==100||BATCH_400_ADDITIONS.length!==100||fixture.tasks.length!==100||new Set(BATCH_400_ADDITIONS.map(x=>x.id)).size!==100||new Set(BATCH_400_ADDITIONS.map(x=>x.execute)).size!==100||BATCH_400_ADDITIONS.some(x=>prior.ids.includes(x.id)))throw new Error('operator count or collision');
if(!/^# pass 9$/mu.test(proof)||!/^# fail 0$/mu.test(proof)||!/^# tests 9$/mu.test(proof)||report.executed!==100||report.failed!==0||report.results.length!==100)throw new Error('offline evidence missing or failed');
const audit={kind:'GAUSS_SECOND_BATCH_OFFLINE_AUDIT',status:'LOCAL_PASS_NOT_INTEGRATED',node:process.version,priorBundleIds:prior.ids.length,newRegisteredIds:BATCH_400_ADDITIONS.length,newExecutableFunctions:new Set(BATCH_400_ADDITIONS.map(x=>x.execute)).size,idCollisions:0,byDomain:Object.fromEntries(['MATHEMATICS','COMPUTER_SCIENCE','STATISTICS_PROBABILITY'].map(d=>[d,BATCH_400_ADDITIONS.filter(x=>x.domain===d).length])),localTests:{tests:9,passed:9,failed:0},offlineExecution:{executed:report.executed,failed:report.failed,reportSha256:report.reportSha256},staticScan:{thirdPartyImports,externalApiTokens,secretTokens},benchmarkScope:benchmark.method,limitations:['not installed in Nexus repository','not run through Quantum/WALLE integrated CI','performance samples do not prove general scalability','no external security audit'],files};
console.log(JSON.stringify(audit,null,2));
