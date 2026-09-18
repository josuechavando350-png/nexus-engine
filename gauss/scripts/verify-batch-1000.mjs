#!/usr/bin/env node
import assert from 'node:assert/strict';
import {lstat,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NEW_200_ADDITIONS} from '../core/batch-1000-additions.mjs';
import {canonical,hash,executeOffline} from './batch-1000-runner.mjs';
export async function verify(report){assert.equal(report?.engineId,'GAUSS_OFFLINE_801_1000');assert.equal(report.status,'LOCAL_PASS_NOT_INTEGRATED');assert.equal(report.priorNewOperators,600);assert.equal(report.newOperators,200);assert.equal(report.executed,200);assert.equal(report.failed,0);assert.equal(report.rows?.length,200);const {reportSha256,...unsigned}=report;assert.equal(reportSha256,hash(unsigned));for(let i=0;i<200;i++){const r=report.rows[i],d=NEW_200_ADDITIONS[i];assert.equal(r.id,d.id);assert.equal(r.domain,d.domain);assert.equal(r.status,'EXECUTED');assert.equal(r.inputSha256,hash(d.input));assert.equal(r.outputSha256,hash(r.output));}assert.equal(canonical(report),canonical(await executeOffline()),'replayed output differs from supplied evidence');return {verified:true,executed:200,reportSha256};}
export async function verifyFile(path){const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||st.size<1||st.size>16*1024*1024)throw new Error('bounded regular evidence file required');return verify(JSON.parse(await readFile(path,'utf8')));}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){if(process.argv.length!==3)throw new Error('usage: node verify-batch-1000.mjs <report.json>');console.log(JSON.stringify(await verifyFile(resolve(process.argv[2]))));}
