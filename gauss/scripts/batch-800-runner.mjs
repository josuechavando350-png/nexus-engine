#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {NEW_200_ADDITIONS} from '../core/batch-800-additions.mjs';
export function canonical(x){if(x===null||typeof x==='boolean'||typeof x==='string')return JSON.stringify(x);if(typeof x==='number'){if(!Number.isFinite(x))throw new TypeError('nonfinite numeric result');return JSON.stringify(Object.is(x,-0)?0:x);}if(Array.isArray(x))return `[${x.map(canonical).join(',')}]`;if(x&&typeof x==='object'){const keys=Object.keys(x).sort();return `{${keys.map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')}}`;}throw new TypeError('non-JSON result');}
export const hash=x=>`sha256:${createHash('sha256').update(canonical(x)).digest('hex')}`;
export async function executeOffline(){const rows=[];for(const def of NEW_200_ADDITIONS){const input=structuredClone(def.input),out=await def.execute(input);rows.push({id:def.id,domain:def.domain,status:'EXECUTED',inputSha256:hash(input),output:out,outputSha256:hash(out)});}const unsigned={engineId:'GAUSS_OFFLINE_601_800',status:'LOCAL_PASS_NOT_INTEGRATED',priorNewOperators:400,newOperators:200,executed:rows.length,failed:0,rows};return {...unsigned,reportSha256:hash(unsigned)};}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const report=await executeOffline();if(process.argv.length>3)throw new Error('usage: node gauss/scripts/batch-800-runner.mjs [report.json]');if(process.argv[2])await writeFile(resolve(process.argv[2]),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,executed:report.executed,reportSha256:report.reportSha256}));}
