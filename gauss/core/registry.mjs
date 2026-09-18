// GAUSS batch 001–200 is preserved; subsequent operators are distinct, bounded computations.
import {deepFreeze} from './common.mjs';
import {GAUSS_DOMAINS, GAUSS_IMPLEMENTED_LAYERS as established} from './registry-prebatch.mjs';
import {BATCH_200_ADDITIONS} from './batch-200-additions.mjs';
import {solveExactLinearSystem} from './precision/exact-linear.mjs';
import {exactIntegerDeterminant} from './precision/exact-integer-determinant.mjs';
import {generalizedChineseRemainder, finiteFieldMatrixInverse} from './layers/exact-algebra-extensions.mjs';
import {exactIntegerPolynomialResultant} from './layers/integer-polynomial-resultant.mjs';
import {exactIntegerPolynomialDiscriminant} from './layers/integer-polynomial-discriminant.mjs';
export {GAUSS_DOMAINS};
const ids=new Set(established.map(x=>x.id));
const domainIds=new Set(GAUSS_DOMAINS.map(x=>x.id));
if(established.length!==116 || BATCH_200_ADDITIONS.length!==84 || ids.size!==116) throw new Error('GAUSS first-batch baseline or addition count mismatch');
// Exact computation is opt-in on two existing IDs. The original Number-based
// implementations still handle inputs without mode, with no fabricated IDs.
const precisionEnabled=established.map(layer=>{
 if(layer.id==='GAUSS.MATH.GAUSSIAN_SOLVE.005') return {...layer,execute(input){
  if(input?.mode==='EXACT_RATIONAL') return solveExactLinearSystem(input);
  if(input&&Object.hasOwn(input,'mode')) throw new TypeError('unsupported GAUSS Gaussian solver mode');
  return layer.execute(input);
 }};
 if(layer.id==='GAUSS.MATH.PIVOTED_LOGDET.006') return {...layer,execute(input){
  if(input?.mode==='EXACT_INTEGER') return exactIntegerDeterminant(input);
  if(input&&Object.hasOwn(input,'mode')) throw new TypeError('unsupported GAUSS determinant mode');
  return layer.execute(input);
 }};
 return layer;
});
const extensions=[
 {id:'GAUSS.MATH.CRT_GENERAL.059',domain:'MATHEMATICS',description:'Exact bounded generalized Chinese remainder with noncoprime consistency detection',execute:generalizedChineseRemainder},
 {id:'GAUSS.MATH.FINITE_FIELD_MATRIX_INVERSE.060',domain:'MATHEMATICS',description:'Exact prime-field square-matrix inversion and singularity detection',execute:finiteFieldMatrixInverse},
 {id:'GAUSS.MATH.INTEGER_POLYNOMIAL_RESULTANT.061',domain:'MATHEMATICS',description:'Exact integer polynomial resultant by bounded Sylvester determinant',execute:exactIntegerPolynomialResultant},
 {id:'GAUSS.MATH.INTEGER_POLYNOMIAL_DISCRIMINANT.062',domain:'MATHEMATICS',description:'Exact integer polynomial discriminant and repeated-complex-root detection',execute:exactIntegerPolynomialDiscriminant},
];
const newlyImplemented=[...BATCH_200_ADDITIONS,...extensions].map(({id,domain,description,execute})=>{
 if(typeof id!=='string'||ids.has(id))throw new Error(`duplicate GAUSS layer id:${id}`);
 if(!domainIds.has(domain))throw new Error(`unknown GAUSS domain:${domain}`);
 if(typeof execute!=='function')throw new Error(`GAUSS layer is not executable:${id}`);
 if(typeof description!=='string'||!description.trim())throw new Error(`GAUSS layer description missing:${id}`);
 ids.add(id);return {id,domain,description,execute};
});
export const GAUSS_IMPLEMENTED_LAYERS=deepFreeze([...precisionEnabled,...newlyImplemented]);
if(GAUSS_IMPLEMENTED_LAYERS.length!==204||ids.size!==204||new Set(GAUSS_IMPLEMENTED_LAYERS.map(x=>x.execute)).size!==204)throw new Error('GAUSS registry does not contain 204 unique executable operators');
const byId=new Map(GAUSS_IMPLEMENTED_LAYERS.map(layer=>[layer.id,layer]));
export function getGaussLayer(layerId){return byId.get(layerId)??null;}
export function gaussRegistrySummary(){
 const implementedByDomain=Object.fromEntries(GAUSS_DOMAINS.map(domain=>[domain.id,0]));
 for(const layer of GAUSS_IMPLEMENTED_LAYERS)implementedByDomain[layer.domain]++;
 return deepFreeze({targetLayerCount:GAUSS_DOMAINS.reduce((sum,domain)=>sum+domain.targetLayers,0),implementedLayerCount:GAUSS_IMPLEMENTED_LAYERS.length,implementedByDomain,domains:GAUSS_DOMAINS});
}
