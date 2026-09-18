import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {BATCH_500_ADDITIONS} from '../core/batch-500-additions.mjs';
export const canonical=x=>{
 if(x===null||typeof x==='boolean')return JSON.stringify(x);
 if(typeof x==='number'){if(!Number.isFinite(x))throw new TypeError('non-finite output');return JSON.stringify(Object.is(x,-0)?0:x);}
 if(typeof x==='string')return JSON.stringify(x.normalize('NFC'));
 if(Array.isArray(x))return `[${x.map(canonical).join(',')}]`;
 if(x&&typeof x==='object'){const pairs=Object.entries(x).map(([k,v])=>[k.normalize('NFC'),v]).sort(([a],[b])=>a<b?-1:a>b?1:0);if(new Set(pairs.map(([k])=>k)).size!==pairs.length)throw new TypeError('colliding output keys');return `{${pairs.map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;}
 throw new TypeError('non-JSON output');
};
export const hash=x=>`sha256:${createHash('sha256').update(canonical(x)).digest('hex')}`;
export const fixtureUrl=new URL('../fixtures/batch-500-problem.json',import.meta.url);
export const manifestUrl=new URL('../fixtures/prior-200-ids.json',import.meta.url);
export async function executeBatch500(fixture=null){
 fixture ??= JSON.parse(await readFile(fixtureUrl,'utf8'));
 if(fixture.schemaVersion!==1||fixture.batch!=='401–500'||!Array.isArray(fixture.tasks)||fixture.tasks.length!==100)throw new Error('invalid immutable batch fixture');
 const definitions=new Map(BATCH_500_ADDITIONS.map(x=>[x.id,x]));
 const prior=JSON.parse(await readFile(manifestUrl,'utf8'));
 if(prior.length!==200||new Set(prior).size!==200)throw new Error('prior batch manifest invalid');
 if(BATCH_500_ADDITIONS.some(x=>prior.includes(x.id)))throw new Error('new ID collides with prior 200');
 if(new Set(fixture.tasks.map(t=>t.taskId)).size!==100||new Set(fixture.tasks.map(t=>t.layerId)).size!==100||new Set(fixture.tasks.map(t=>t.layerId)).size!==definitions.size)throw new Error('fixture coverage not unique');
 const results=fixture.tasks.map(task=>{
  const def=definitions.get(task.layerId);if(!def||task.taskId!==def.id||canonical(task.input)!==canonical(def.input))throw new Error(`fixture input or definition mismatch: ${task.layerId}`);
  const input=structuredClone(task.input),inputSha256=hash(input);
  let output;try{output=def.execute(input);}catch(error){throw new Error(`${def.id} failed: ${error.message}`,{cause:error});}
  canonical(output);if(!Object.isFrozen(output))throw new Error(`unfrozen output: ${def.id}`);
  return {taskId:def.id,layerId:def.id,domain:def.domain,status:'EXECUTED',inputSha256,output,outputSha256:hash(output)};
 });
 const unsigned={schemaVersion:1,batch:'401–500',engineId:'GAUSS_BATCH_500_OFFLINE',status:'LOCAL_PASS_NOT_INTEGRATED',operatorCount:100,priorOperatorCount:200,failedCount:0,fixtureSha256:hash(fixture),results};
 return {...unsigned,reportSha256:hash(unsigned)};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const report=await executeBatch500();const text=JSON.stringify(report,null,2)+'\n';if(process.argv[2])await writeFile(resolve(process.argv[2]),text);else process.stdout.write(text);
}
