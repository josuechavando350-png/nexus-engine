#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {BATCH_400_ADDITIONS} from '../core/batch-400-additions.mjs';
const sha256=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function verifyBatch400Evidence(report){
 const fixture=JSON.parse(await readFile(new URL('../fixtures/batch-400-problem.json',import.meta.url),'utf8'));
 if(!report||Object.keys(report).sort().join(',')!=='batch,executed,failed,implemented,reportSha256,results'||report.batch!=='301–400'||report.implemented!==100||report.executed!==100||report.failed!==0||!Array.isArray(report.results)||report.results.length!==100)throw new Error('invalid report envelope or incomplete coverage');
 const {reportSha256,...unsigned}=report;
 if(reportSha256!==sha256(unsigned))throw new Error('report SHA-256 mismatch');
 for(let i=0;i<100;i++){
  const task=fixture.tasks[i],def=BATCH_400_ADDITIONS[i],row=report.results[i];
  if(def.id!==task.layerId||!row||Object.keys(row).sort().join(',')!=='domain,inputSha256,layerId,output,outputSha256,status'||row.layerId!==def.id||row.domain!==def.domain||row.status!=='EXECUTED'||row.inputSha256!==sha256(task.input)||row.outputSha256!==sha256(row.output))throw new Error(`invalid task evidence ${def.id}`);
  if(!isDeepStrictEqual(row.output,def.execute(structuredClone(task.input))))throw new Error(`independent replay differs for ${def.id}`);
 }
 return Object.freeze({status:'PASS',executed:100,reportSha256});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==3)throw new Error('Usage: node gauss/scripts/verify-batch-400.mjs /absolute/path/to/report.json');
 const path=resolve(process.argv[2]),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>2*1024*1024)throw new Error('bounded regular report required');
 const report=JSON.parse(await readFile(path,'utf8'));console.log(JSON.stringify(await verifyBatch400Evidence(report)));
}
