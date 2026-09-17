// GAUSS batch 001–200: preserve all original operator IDs and default semantics.
import {deepFreeze} from './common.mjs';
import {GAUSS_DOMAINS, GAUSS_IMPLEMENTED_LAYERS as established} from './registry-prebatch.mjs';
import {BATCH_200_ADDITIONS} from './batch-200-additions.mjs';
import {exactIntegerDeterminant} from './precision/exact-integer-determinant.mjs';
export {GAUSS_DOMAINS};
const ids=new Set(established.map(x=>x.id));
const domainIds=new Set(GAUSS_DOMAINS.map(x=>x.id));
if(established.length!==116 || BATCH_200_ADDITIONS.length!==84 || ids.size!==116) throw new Error('GAUSS first-batch baseline or addition count mismatch');
// Explicit opt-in extends the existing determinant operation. This DOES NOT add
// a new registered operator ID or change the audited floating-point logdet path.
const precisionEnabled=established.map(layer=>{
 if(layer.id!=='GAUSS.MATH.PIVOTED_LOGDET.006') return layer;
 return {...layer,execute(input){
  if(input?.mode==='EXACT_INTEGER') return exactIntegerDeterminant(input);
  if(input&&Object.hasOwn(input,'mode')) throw new TypeError('unsupported GAUSS determinant mode');
  return layer.execute(input);
 }};
});
const newlyImplemented=BATCH_200_ADDITIONS.map(({id,domain,description,execute})=>{
 if(typeof id!=='string'||ids.has(id))throw new Error(`duplicate GAUSS layer id:${id}`);
 if(!domainIds.has(domain))throw new Error(`unknown GAUSS domain:${domain}`);
 if(typeof execute!=='function')throw new Error(`GAUSS layer is not executable:${id}`);
 if(typeof description!=='string'||!description.trim())throw new Error(`GAUSS layer description missing:${id}`);
 ids.add(id);return {id,domain,description,execute};
});
export const GAUSS_IMPLEMENTED_LAYERS=deepFreeze([...precisionEnabled,...newlyImplemented]);
if(GAUSS_IMPLEMENTED_LAYERS.length!==200||ids.size!==200||new Set(GAUSS_IMPLEMENTED_LAYERS.map(x=>x.execute)).size!==200)throw new Error('GAUSS batch does not contain 200 unique executable operators');
const byId=new Map(GAUSS_IMPLEMENTED_LAYERS.map(layer=>[layer.id,layer]));
export function getGaussLayer(layerId){return byId.get(layerId)??null;}
export function gaussRegistrySummary(){
 const implementedByDomain=Object.fromEntries(GAUSS_DOMAINS.map(domain=>[domain.id,0]));
 for(const layer of GAUSS_IMPLEMENTED_LAYERS)implementedByDomain[layer.domain]++;
 return deepFreeze({targetLayerCount:GAUSS_DOMAINS.reduce((sum,domain)=>sum+domain.targetLayers,0),implementedLayerCount:GAUSS_IMPLEMENTED_LAYERS.length,implementedByDomain,domains:GAUSS_DOMAINS});
}
