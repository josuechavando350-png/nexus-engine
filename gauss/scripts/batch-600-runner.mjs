#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {BATCH_600_ADDITIONS} from '../core/batch-600-additions.mjs';
export function canonical(value){
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number'){if(!Number.isFinite(value))throw new TypeError('nonfinite report value');return JSON.stringify(Object.is(value,-0)?0:value);}
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')}}`;
 throw new TypeError('non-JSON report value');
}
export const hash=x=>'sha256:'+createHash('sha256').update(canonical(x),'utf8').digest('hex');
export async function executeBatch600(){
 const results=[];
 for(const layer of BATCH_600_ADDITIONS){const input=structuredClone(layer.input),output=await layer.execute(input);
 results.push({taskId:`offline-${layer.id}`,layerId:layer.id,domain:layer.domain,status:'EXECUTED',inputSha256:hash(input),output,outputSha256:hash(output)});}
 const unsigned={engineId:'GAUSS_BATCH_600_OFFLINE',status:'LOCAL_PASS_NOT_INTEGRATED',operatorCount:100,priorNewOperatorCount:300,failedCount:0,results};
 return {...unsigned,reportSha256:hash(unsigned)};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){if(process.argv.length>3)throw new Error('Usage: node batch-600-runner.mjs [report-path]');const report=await executeBatch600();if(process.argv[2])await writeFile(resolve(process.argv[2]),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,executed:report.results.length,reportSha256:report.reportSha256}));}
