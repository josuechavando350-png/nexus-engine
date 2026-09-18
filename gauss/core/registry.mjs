// GAUSS batch 001–200: preserve the previously audited 116 operators byte-for-byte.
import {deepFreeze} from './common.mjs';
import {GAUSS_DOMAINS as historicalDomains, GAUSS_IMPLEMENTED_LAYERS as established} from './registry-prebatch.mjs';
import {BATCH_200_ADDITIONS} from './batch-200-additions.mjs';
import {BATCH_300_ADDITIONS} from './batch-300-additions.mjs';
import {BATCH_400_ADDITIONS} from './batch-400-additions.mjs';
import {BATCH_500_ADDITIONS} from './batch-500-additions.mjs';
import {BATCH_600_ADDITIONS} from './batch-600-additions.mjs';
import {NEW_200_ADDITIONS as BATCH_601_800} from './batch-800-additions.mjs';
import {NEW_200_ADDITIONS as BATCH_801_1000} from './batch-1000-additions.mjs';
const fullDefinitions=[...established,...BATCH_200_ADDITIONS,...BATCH_300_ADDITIONS,...BATCH_400_ADDITIONS,...BATCH_500_ADDITIONS,...BATCH_600_ADDITIONS,...BATCH_601_800,...BATCH_801_1000];
// The requested 1,000-operator inventory is NOT eight evenly populated domains.
// Pin this audited distribution independently from the loaded implementation count;
// a removed or reassigned operator must not silently rewrite the target.
const EXPECTED_DOMAIN_COUNTS=deepFreeze({
 MATHEMATICS:357,PHYSICS_COMPLEX_SYSTEMS:28,COMPUTER_SCIENCE:302,
 STATISTICS_PROBABILITY:131,DECISION_THEORY:11,CAUSAL_EXPERIMENTAL:2,
 CONTROL_DYNAMICS:64,INFORMATION_THEORY:105,
});
const plannedByDomain=Object.fromEntries(historicalDomains.map(domain=>[domain.id,0]));
if(Object.keys(plannedByDomain).length!==Object.keys(EXPECTED_DOMAIN_COUNTS).length||
 Object.keys(plannedByDomain).some(id=>!Object.hasOwn(EXPECTED_DOMAIN_COUNTS,id)))throw Error('GAUSS domain contract changed');
for(const def of fullDefinitions){if(!Object.hasOwn(plannedByDomain,def.domain))throw Error('Unknown GAUSS domain: '+def.domain);plannedByDomain[def.domain]++;}
for(const [id,expected] of Object.entries(EXPECTED_DOMAIN_COUNTS))if(plannedByDomain[id]!==expected)throw Error('GAUSS domain coverage mismatch: '+id);
export const GAUSS_DOMAINS=deepFreeze(historicalDomains.map(domain=>({...domain,targetLayers:EXPECTED_DOMAIN_COUNTS[domain.id]})));
const ids=new Set(established.map(x=>x.id));
const domainIds=new Set(GAUSS_DOMAINS.map(x=>x.id));
if(established.length!==116 || BATCH_200_ADDITIONS.length!==84 || ids.size!==116) throw new Error('GAUSS first-batch baseline or addition count mismatch');
const newlyImplemented=BATCH_200_ADDITIONS.map(({id,domain,description,execute})=>{
 if(typeof id!=='string'||ids.has(id))throw new Error(`duplicate GAUSS layer id:${id}`);
 if(!domainIds.has(domain))throw new Error(`unknown GAUSS domain:${domain}`);
 if(typeof execute!=='function')throw new Error(`GAUSS layer is not executable:${id}`);
 if(typeof description!=='string'||!description.trim())throw new Error(`GAUSS layer description missing:${id}`);
 ids.add(id);return {id,domain,description,execute};
});
const historical=deepFreeze([...established,...newlyImplemented]);
if(historical.length!==200||ids.size!==200||new Set(historical.map(x=>x.execute)).size!==200)throw new Error('Historical GAUSS 200-operator baseline mismatch');
const functions=new Set(historical.map(x=>x.execute));
const extensions=[...BATCH_300_ADDITIONS,...BATCH_400_ADDITIONS,...BATCH_500_ADDITIONS,...BATCH_600_ADDITIONS,...BATCH_601_800,...BATCH_801_1000].map(({id,domain,description,execute})=>{
 if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)||ids.has(id))throw Error('GAUSS duplicate or invalid ID: '+id);
 if(!domainIds.has(domain))throw Error('Unknown GAUSS domain: '+domain);
 if(typeof execute!=='function'||functions.has(execute))throw Error('GAUSS duplicate or invalid executable: '+id);
 if(typeof description!=='string'||!description.trim())throw Error('GAUSS missing description: '+id);
 ids.add(id);functions.add(execute);return {id,domain,description,execute};
});
export const GAUSS_IMPLEMENTED_LAYERS=deepFreeze([...historical,...extensions]);
if(GAUSS_IMPLEMENTED_LAYERS.length!==1000||ids.size!==1000||functions.size!==1000)throw Error('GAUSS 1,000-operator integration incomplete');
const byId=new Map(GAUSS_IMPLEMENTED_LAYERS.map(layer=>[layer.id,layer]));
export function getGaussLayer(layerId){return byId.get(layerId)??null;}
export function gaussRegistrySummary(){
 const implementedByDomain=Object.fromEntries(GAUSS_DOMAINS.map(domain=>[domain.id,0]));
 for(const layer of GAUSS_IMPLEMENTED_LAYERS)implementedByDomain[layer.domain]++;
 return deepFreeze({targetLayerCount:GAUSS_DOMAINS.reduce((sum,domain)=>sum+domain.targetLayers,0),implementedLayerCount:GAUSS_IMPLEMENTED_LAYERS.length,implementedByDomain,domains:GAUSS_DOMAINS});
}
