#!/usr/bin/env node
// This standalone offline runner proves local registration and reproducible output.
// It does NOT claim that the future Nexus/Quantum/WALLE repository integration passed.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {BATCH_400_ADDITIONS} from '../core/batch-400-additions.mjs';
const file=new URL('../fixtures/batch-400-problem.json',import.meta.url);
const bytes=await readFile(file);
if(bytes.length>256*1024)throw new RangeError('batch fixture exceeds 256 KiB');
const problem=JSON.parse(bytes.toString('utf8'));
if(problem.schemaVersion!==1||problem.batch!=='301–400'||!Array.isArray(problem.tasks)||problem.tasks.length!==100)throw new Error('unexpected batch fixture');
const byId=new Map(BATCH_400_ADDITIONS.map(x=>[x.id,x]));
const sha256=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const results=[];const ids=new Set();
for(const task of problem.tasks){
 if(!task||Object.keys(task).sort().join(',')!=='input,layerId,taskId'||task.taskId!==task.layerId||ids.has(task.layerId))throw new Error('missing, repeated, or invalid task');
 const def=byId.get(task.layerId);if(!def||JSON.stringify(task.input)!==JSON.stringify(def.input))throw new Error('fixture input not bound to definition');
 ids.add(task.layerId);const input=structuredClone(task.input);const before=JSON.stringify(input);
 const output=def.execute(input);
 if(before!==JSON.stringify(input)||!Object.isFrozen(output)||JSON.stringify(output)!==JSON.stringify(def.execute(structuredClone(task.input))))throw new Error(`impure or nondeterministic kernel: ${task.layerId}`);
 results.push({layerId:task.layerId,domain:def.domain,status:'EXECUTED',inputSha256:sha256(input),output,outputSha256:sha256(output)});
}
if(ids.size!==byId.size)throw new Error('coverage mismatch');
const report={batch:problem.batch,implemented:byId.size,executed:results.length,failed:0,results};
process.stdout.write(`${JSON.stringify({...report,reportSha256:sha256(report)},null,2)}\n`);
