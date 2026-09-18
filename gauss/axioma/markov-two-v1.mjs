/* AXIOMA first two bounded Markov operators: independent integer-product probability reference. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GAUSS_IMPLEMENTED_LAYERS,getGaussLayer} from '../core/registry.mjs';
const TAGS=['NORMALIZE','PATH_PROBABILITY'];
const ids=['GAUSS.STATS.EXACT_MARKOV.NORMALIZE.951','GAUSS.STATS.EXACT_MARKOV.PATH_PROBABILITY.954'];
function gcd(a,b){while(b){const r=a%b;a=b;b=r;}return a;}
function ratio(a,b){if(!b)throw Error('zero weight row');const g=gcd(a,b);return `${a/g}/${b/g}`;}
function reference(tag,input){const weights=input.weights,totals=weights.map(row=>row.reduce((s,v)=>s+BigInt(v),0n));
 if(tag==='NORMALIZE')return {transition:weights.map((row,i)=>row.map(value=>ratio(BigInt(value),totals[i])))};
 let numerator=1n,denominator=1n;for(let j=1;j<input.path.length;j++){const from=input.path[j-1],to=input.path[j];numerator*=BigInt(weights[from][to]);denominator*=totals[from];}return {probability:ratio(numerator,denominator)};
}
function rng(seed){let state=seed>>>0;return max=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)%max;};}
function inputFor(tag,i,r){const n=1+r(4),weights=Array.from({length:n},()=>Array.from({length:n},()=>r(8)));for(const row of weights)if(row.every(v=>v===0))row[r(n)]=1;
 if(i%11===0)weights[0]=Array.from({length:n},(_,j)=>j===0?1:0);
 if(i%17===0)weights[0]=Array.from({length:n},()=>3);
 return tag==='NORMALIZE'?{weights}:{weights,path:Array.from({length:1+r(8)},()=>r(n))};}
export function runTwoMarkovBank({resolveLayer=getGaussLayer}={}){
 assert.equal(GAUSS_IMPLEMENTED_LAYERS.length,1000);
 const report={schemaVersion:1,subject:'GAUSS exact Markov transition normalization and path probability',seed:'0x755eee12',oracle:'direct BigInt transition-row counting and path numerator/denominator integer products',registryOperators:1000,coveredOperators:0,validCases:0,passedValidCases:0,failedValidCases:0,invalidCases:0,passedInvalidRejections:0,failedInvalidRejections:0,operatorResults:[],failures:[],caseDigest:''};
 const hash=createHash('sha256');for(const [index,tag]of TAGS.entries()){
 const layerId=ids[index],layer=resolveLayer(layerId);assert.equal(typeof layer?.execute,'function',`missing ${layerId}`);
 const r=rng(Number.parseInt(createHash('sha256').update(layerId).digest('hex').slice(0,8),16)^0x755eee12),item={id:layerId,validCases:0,passed:0,failed:0,invalidCases:0,rejected:0,invalidAccepted:0};
 for(let j=0;j<100;j++){const input=inputFor(tag,j,r),expected=reference(tag,input);hash.update(JSON.stringify({id:layerId,j,input,expected}));item.validCases++;report.validCases++;let actual;
 try{actual=layer.execute(structuredClone(input));assert.deepStrictEqual(actual,expected);item.passed++;report.passedValidCases++;}
 catch(error){item.failed++;report.failedValidCases++;if(report.failures.length<20)report.failures.push({id:layerId,j,input,expected,actual:actual??null,reason:String(error)});}
 if(j===0){const negative=structuredClone(input);negative.weights[0][0]=-1;const zero=structuredClone(input);zero.weights[0].fill(0);const bad=[{...input,unexpected:true},negative,zero];
 for(const[k,v]of bad.entries()){item.invalidCases++;report.invalidCases++;try{const out=layer.execute(structuredClone(v));item.invalidAccepted++;report.failedInvalidRejections++;if(report.failures.length<20)report.failures.push({id:layerId,j:`invalid-${k}`,input:v,actual:out,reason:'invalid accepted'});}catch{item.rejected++;report.passedInvalidRejections++;}}
 }
 }report.coveredOperators++;report.operatorResults.push(item);
 }report.untestedOperators=1000-report.coveredOperators;report.caseDigest=`sha256:${hash.digest('hex')}`;report.validPassRate=report.passedValidCases/report.validCases;report.invalidRejectionRate=report.passedInvalidRejections/report.invalidCases;return report;
}
