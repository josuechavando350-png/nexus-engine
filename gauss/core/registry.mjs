// GAUSS registry. Preserve the audited 001–200 baseline and extend only with strict executable batches.
import {deepFreeze} from './common.mjs';
import {GAUSS_DOMAINS, GAUSS_IMPLEMENTED_LAYERS as established} from './registry-prebatch.mjs';
import {BATCH_200_ADDITIONS} from './batch-200-additions.mjs';
import {BATCH_201_500_MATH_A} from './batch-201-500-math-a.mjs';
export {GAUSS_DOMAINS};
const ids=new Set(established.map(x=>x.id));
const domainIds=new Set(GAUSS_DOMAINS.map(x=>x.id));
if(established.length!==116 || BATCH_200_ADDITIONS.length!==84 || ids.size!==116) throw new Error('GAUSS first-batch baseline or addition count mismatch');
function acceptBatch(batch,label){
 if(!Array.isArray(batch)||batch.length===0)throw new Error(`empty GAUSS batch:${label}`);
 return batch.map(({id,domain,description,execute})=>{
  if(typeof id!=='string'||ids.has(id))throw new Error(`duplicate GAUSS layer id:${id}`);
  if(!domainIds.has(domain))throw new Error(`unknown GAUSS domain:${domain}`);
  if(typeof execute!=='function')throw new Error(`GAUSS layer is not executable:${id}`);
  if(typeof description!=='string'||!description.trim())throw new Error(`GAUSS layer description missing:${id}`);
  ids.add(id);return {id,domain,description,execute};
 });
}
const batch200=acceptBatch(BATCH_200_ADDITIONS,'001-200 additions');
const batch201500a=acceptBatch(BATCH_201_500_MATH_A,'201-500 math-a');
export const GAUSS_IMPLEMENTED_LAYERS=deepFreeze([...established,...batch200,...batch201500a]);
const expectedCount=116+BATCH_200_ADDITIONS.length+BATCH_201_500_MATH_A.length;
if(GAUSS_IMPLEMENTED_LAYERS.length!==expectedCount||ids.size!==expectedCount||new Set(GAUSS_IMPLEMENTED_LAYERS.map(x=>x.execute)).size!==expectedCount)throw new Error('GAUSS registry uniqueness/integrity failure');
const byId=new Map(GAUSS_IMPLEMENTED_LAYERS.map(layer=>[layer.id,layer]));
export function getGaussLayer(layerId){return byId.get(layerId)??null;}
export function gaussRegistrySummary(){
 const implementedByDomain=Object.fromEntries(GAUSS_DOMAINS.map(domain=>[domain.id,0]));
 for(const layer of GAUSS_IMPLEMENTED_LAYERS)implementedByDomain[layer.domain]++;
 return deepFreeze({targetLayerCount:GAUSS_DOMAINS.reduce((sum,domain)=>sum+domain.targetLayers,0),implementedLayerCount:GAUSS_IMPLEMENTED_LAYERS.length,implementedByDomain,domains:GAUSS_DOMAINS});
}
