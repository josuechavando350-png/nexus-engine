import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {lstat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {canonical,hash,executeBatch500} from './batch-500-runner.mjs';
export async function verifyReport(report){
 assert.equal(report?.engineId,'GAUSS_BATCH_500_OFFLINE');
 assert.equal(report?.status,'LOCAL_PASS_NOT_INTEGRATED');
 assert.equal(report?.operatorCount,100);assert.equal(report?.priorOperatorCount,200);assert.equal(report?.failedCount,0);
 assert.equal(report?.results?.length,100);assert.equal(new Set(report.results.map(r=>r.layerId)).size,100);
 const {reportSha256,...unsigned}=report;assert.equal(reportSha256,hash(unsigned),'report hash does not match');
 for(const r of report.results){assert.equal(r.status,'EXECUTED');assert.equal(r.outputSha256,hash(r.output));}
 const independent=await executeBatch500();
 assert.equal(canonical(report),canonical(independent),'independent rerun differs from submitted report');
 return {verified:true,executed:100,reportSha256};
}
export async function verifyReportFile(path){const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024||stat.size===0)throw new Error('report must be bounded regular file');return verifyReport(JSON.parse(await readFile(path,'utf8')));}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){if(process.argv.length!==3)throw new Error('Usage: node verify-batch-500.mjs <report.json>');console.log(JSON.stringify(await verifyReportFile(resolve(process.argv[2]))));}
