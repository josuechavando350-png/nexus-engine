#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {BATCH_600_ADDITIONS} from '../core/batch-600-additions.mjs';
import {canonical,hash,executeBatch600} from './batch-600-runner.mjs';
export async function verifyBatch600(report){
 assert.equal(report?.engineId,'GAUSS_BATCH_600_OFFLINE');
 assert.equal(report?.status,'LOCAL_PASS_NOT_INTEGRATED');
 assert.equal(report?.operatorCount,100);assert.equal(report?.priorNewOperatorCount,300);assert.equal(report?.failedCount,0);
 assert.equal(report?.results?.length,100);
 assert.deepEqual(new Set(report.results.map(x=>x.layerId)),new Set(BATCH_600_ADDITIONS.map(x=>x.id)));
 const {reportSha256,...unsigned}=report;assert.equal(reportSha256,hash(unsigned),'report hash mismatch');
 for(const [i,row]of report.results.entries()){
  assert.equal(row.layerId,BATCH_600_ADDITIONS[i].id);assert.equal(row.status,'EXECUTED');
  assert.equal(row.inputSha256,hash(BATCH_600_ADDITIONS[i].input));assert.equal(row.outputSha256,hash(row.output));
 }
 const independent=await executeBatch600();assert.equal(canonical(report),canonical(independent),'independent operator replay differs from claimed report');
 return {verified:true,executed:100,reportSha256};
}
export async function verifyFile(path){const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>8*1024*1024)throw new Error('bounded regular report required');return verifyBatch600(JSON.parse(await readFile(path,'utf8')));}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){if(process.argv.length!==3)throw new Error('Usage: node verify-batch-600.mjs <report-path>');console.log(JSON.stringify(await verifyFile(resolve(process.argv[2]))));}
