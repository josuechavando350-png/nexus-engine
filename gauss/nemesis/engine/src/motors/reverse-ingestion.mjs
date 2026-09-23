import { createHash } from 'node:crypto';
import { object, array, id, unique } from './shared.mjs';

function canonical(v, depth=0) {
  if (depth>24) throw new TypeError('JSON nesting exceeds 24');
  if (v===null || typeof v==='boolean' || typeof v==='string') return JSON.stringify(v);
  if (typeof v==='number' && Number.isFinite(v) && Number.isSafeInteger(v)) return JSON.stringify(v);
  if (Array.isArray(v)) {if(v.length>256)throw new TypeError('JSON array exceeds 256');return `[${v.map(x=>canonical(x,depth+1)).join(',')}]`;}
  if(v && typeof v==='object' && (Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null)) {
    const keys=Object.keys(v).sort();if(keys.length>128)throw new TypeError('JSON object exceeds 128 keys');
    for(const k of keys)if(['__proto__','constructor','prototype'].includes(k))throw new TypeError('unsafe JSON key');
    return `{${keys.map(k=>`${JSON.stringify(k)}:${canonical(v[k],depth+1)}`).join(',')}}`;
  }
  throw new TypeError('only finite JSON with safe integers is supported');
}
const hash=v=>createHash('sha256').update('NEMESIS_REVERSE_INGEST_V1\0').update(canonical(v)).digest('hex');
const clone=v=>JSON.parse(canonical(v));
function records(entries,label) {
  const rows=array(entries,label,0,256);const ids=unique(rows.map((v,i)=>{object(v,`${label}[${i}]`,['id','data']);return id(v.id,`${label}[${i}].id`);}),label);
  const map=new Map();rows.forEach((v,i)=>{canonical(v.data);map.set(ids[i],clone(v.data));});return map;
}
/** Deterministic reverse-ETL plan, with optimistic CAS and atomic in-memory application. */
export function planReverseIngestion(input) {
  object(input,'reverse ingestion',['source','destination','deleteMissing'],['source','destination']);
  if(input.deleteMissing!==undefined && typeof input.deleteMissing!=='boolean')throw new TypeError('deleteMissing must be boolean');
  const source=records(input.source,'source'),destination=records(input.destination,'destination');
  const operations=[];
  for(const key of [...source.keys()].sort()){
    const data=source.get(key), current=destination.get(key);
    if(current===undefined)operations.push({kind:'CREATE',id:key,beforeHash:null,afterHash:hash(data),data});
    else if(hash(current)!==hash(data))operations.push({kind:'UPDATE',id:key,beforeHash:hash(current),afterHash:hash(data),data});
  }
  if(input.deleteMissing===true)for(const key of [...destination.keys()].sort())if(!source.has(key))operations.push({kind:'DELETE',id:key,beforeHash:hash(destination.get(key)),afterHash:null});
  const plan={version:1,deleteMissing:input.deleteMissing===true,operations};
  return {engine:'NEMESIS_REVERSE_INGESTION_V1',domain:'BOUNDED_JSON_RECORD_RECONCILIATION',status:'DRY_RUN',
    sourceCount:source.size,destinationCount:destination.size,plan,planHash:hash(plan),
    note:'No network access or external mutation. Deletion disabled by default. APPLY uses compare-and-swap on the supplied in-memory destination.'};
}
export function applyReverseIngestion(planResult,destination) {
  object(planResult,'plan result',['engine','domain','status','sourceCount','destinationCount','plan','planHash','note']);
  if(planResult.engine!=='NEMESIS_REVERSE_INGESTION_V1'||planResult.status!=='DRY_RUN')throw new TypeError('not a reverse ingestion plan');
  const plan=planResult.plan;
  object(plan,'plan',['version','deleteMissing','operations']);
  if(plan.version!==1 || typeof plan.deleteMissing!=='boolean'||hash(plan)!==planResult.planHash)throw new TypeError('plan digest mismatch');
  const state=records(destination,'destination');
  const operations=array(plan.operations,'operations',0,512);
  unique(operations.map((op,i)=>{
    object(op,`operations[${i}]`,op.kind==='DELETE'?['kind','id','beforeHash','afterHash']:['kind','id','beforeHash','afterHash','data']);
    if(!['CREATE','UPDATE','DELETE'].includes(op.kind))throw new TypeError('invalid operation');
    id(op.id,'operation.id');
    if(op.kind==='DELETE'&&!plan.deleteMissing)throw new TypeError('unexpected deletion');
    if(op.kind==='CREATE' && op.beforeHash!==null)throw new TypeError('invalid create precondition');
    if(op.kind!=='CREATE' && !/^[0-9a-f]{64}$/.test(op.beforeHash))throw new TypeError('invalid precondition');
    if(op.kind==='DELETE' && op.afterHash!==null)throw new TypeError('invalid delete hash');
    if(op.kind!=='DELETE' && hash(op.data)!==op.afterHash)throw new TypeError('operation payload mismatch');
    return op.id;
  }),'operation ids');
  // Phase one: validate EVERY precondition before changing a single record.
  const already=[];
  for(const op of operations){
    const current=state.get(op.id),actual=current===undefined?null:hash(current);
    if(actual===op.afterHash) {already.push(op.id);continue;}
    if(actual!==op.beforeHash)throw new Error(`conflict at ${op.id}: destination changed; no records applied`);
  }
  for(const op of operations){
    if(already.includes(op.id))continue;
    if(op.kind==='DELETE')state.delete(op.id);else state.set(op.id,clone(op.data));
  }
  return {engine:'NEMESIS_REVERSE_INGESTION_V1',status:'APPLIED_IN_MEMORY',appliedCount:operations.length-already.length,alreadyAppliedCount:already.length,
    destination:[...state].sort(([a],[b])=>a.localeCompare(b)).map(([key,data])=>({id:key,data})),
    note:'Returned copy only; no persistent store was altered.'};
}
