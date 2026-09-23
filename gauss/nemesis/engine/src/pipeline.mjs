import {createHash} from 'node:crypto';
import {object,array,id,integer} from './motors/shared.mjs';
import {canon} from './motors/finite-tools.mjs';
import {runMotor} from './motors/index.mjs';

/** Local declarative DAG of existing NEMESIS motors; not a Nexus deployment adapter. */
export async function runMotorPipeline(spec){
 object(spec,'pipeline',['tasks'],['tasks']);
 const tasks=array(spec.tasks,'tasks',1,100),completed=new Map(),reports=[];
 function resolve(value){
  if(value===null||typeof value==='string'||typeof value==='number'||typeof value==='boolean'){
   if(typeof value==='number'&&!Number.isFinite(value))throw new TypeError('nonfinite input');return value;
  }
  if(Array.isArray(value))return value.map(resolve);
  if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype)throw new TypeError('pipeline accepts JSON data only');
  if(Object.hasOwn(value,'$ref')){
   object(value,'reference',['$ref']);const ref=object(value.$ref,'$ref',['taskId','path'],['taskId','path']);const key=id(ref.taskId,'reference taskId');
   if(!completed.has(key))throw new TypeError(`missing, forward or failed dependency ${key}`);
   const path=array(ref.path,'reference path',0,32);let at=completed.get(key);
   for(const segment of path){if(typeof segment==='string'){
     if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(segment)||['constructor','prototype','__proto__'].includes(segment)||at===null||typeof at!=='object'||!Object.hasOwn(at,segment))throw new TypeError('invalid reference object path');at=at[segment];
    }else{integer(segment,'reference index',0,100000);if(!Array.isArray(at)||segment>=at.length)throw new TypeError('invalid reference array index');at=at[segment];}}
   return structuredClone(at);
  }
  return Object.fromEntries(Object.entries(value).map(([key,v])=>{if(['__proto__','prototype','constructor'].includes(key))throw new TypeError('forbidden JSON key');return [key,resolve(v)];}));
 }
 for(const [i,raw] of tasks.entries()){
  let taskId=null;
  try{
   object(raw,`tasks[${i}]`,['id','motor','input'],['id','motor','input']);taskId=id(raw.id,`task[${i}].id`);
   if(completed.has(taskId))throw new TypeError('duplicate task id');
   const motor=raw.motor;if(typeof motor!=='string'||!/^(0[2-9]|[1-9][0-9]|100)$/.test(motor))throw new TypeError('invalid motor id');
   const input=resolve(raw.input);if(motor==='08'&&input?.action==='commit')throw new TypeError('private Pedersen opening cannot be emitted from pipeline');
   const output=await runMotor(motor,input);
   if(output?.verified===false||output?.valid===false||output?.converged===false||output?.status&& !['CONSISTENT','PASS','REPAIRED','ALREADY_PASSING','DRY_RUN','APPLIED_IN_MEMORY','OPTIMAL_FINITE','FEASIBLE_CANDIDATE','QUORUM_CERTIFIED','CONVERGED'].includes(output.status))throw new Error(`motor ${motor} returned unsuccessful verification or status`);
   completed.set(taskId,output);
   reports.push({id:taskId,motor,inputSha256:createHash('sha256').update(canon(input)).digest('hex'),outputSha256:createHash('sha256').update(canon(output)).digest('hex'),output});
  }catch(error){return {status:'BLOCKED',failedTaskId:taskId,reason:error.message,tasks:reports};}
 }
 return {status:'PASS',tasks:reports};
}
