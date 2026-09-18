/* Independent finite Boolean oracles: direct truth-table enumeration, not GAUSS transforms. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GAUSS_IMPLEMENTED_LAYERS,getGaussLayer} from '../core/registry.mjs';
const TAGS=['EVALUATE','WEIGHT','ZERO_COUNT','BALANCED','SUPPORT','ESSENTIAL_COUNT','COFACTORS','RESTRICT_ZERO','RESTRICT_ONE','DERIVATIVE','DERIVATIVE_WEIGHT','WALSH','WALSH_COEFF','ANF','ALGEBRAIC_DEGREE','MONOTONE','AFFINE','SYMMETRIC','SELF_DUAL','SAT_WITNESS','FALSIFY_WITNESS','EQUIVALENT','HAMMING','NONLINEARITY','CORRELATION_IMMUNITY_1'];
const id=(tag,i)=>`GAUSS.CS.BOOLEAN_FUNCTIONS.${tag}.${851+i}`;
const count=m=>m.toString(2).replace(/0/g,'').length;
const all=n=>Array.from({length:1<<n},(_,i)=>i);
const variables=n=>Array.from({length:n},(_,i)=>i);
const subset=(a,b)=>(a&b)===a;
const parity=x=>count(x)%2;
const coefficient=(t,s)=>all(Math.log2(t.length)).reduce((sum,m)=>sum+(t[m]?-1:1)*(parity(s&m)?-1:1),0);
// Inclusion-exclusion over each subset is independent of the in-place Moebius transform.
const anf=(t,s)=>all(Math.log2(t.length)).filter(m=>subset(m,s)).reduce((v,m)=>v^t[m],0);
const co=(t,k,b)=>all(Math.log2(t.length)-1).map(m=>t[(m&((1<<k)-1))|((m>>k)<<(k+1))|(b<<k)]);
const differs=(t,k)=>co(t,k,0).map((v,i)=>v^co(t,k,1)[i]);
const spectrum=t=>all(Math.log2(t.length)).map(s=>coefficient(t,s));
const af=t=>all(Math.log2(t.length)).map(s=>anf(t,s));
function reference(tag,x){
 const t=x.table??x.left,n=x.n,domain=all(n),ones=t.reduce((sum,v)=>sum+v,0);
 switch(tag){
 case 'EVALUATE':return {value:t[x.mask]};
 case 'WEIGHT':return {ones};
 case 'ZERO_COUNT':return {zeros:t.length-ones};
 case 'BALANCED':return {balanced:ones*2===t.length};
 case 'SUPPORT':return {variables:variables(n).filter(k=>differs(t,k).some(Boolean))};
 case 'ESSENTIAL_COUNT':return {count:variables(n).filter(k=>differs(t,k).some(Boolean)).length};
 case 'COFACTORS':return {zero:co(t,x.variable,0),one:co(t,x.variable,1)};
 case 'RESTRICT_ZERO':return {table:co(t,x.variable,0)};
 case 'RESTRICT_ONE':return {table:co(t,x.variable,1)};
 case 'DERIVATIVE':return {table:differs(t,x.variable)};
 case 'DERIVATIVE_WEIGHT':return {weight:differs(t,x.variable).filter(Boolean).length};
 case 'WALSH':return {spectrum:spectrum(t)};
 case 'WALSH_COEFF':return {coefficient:coefficient(t,x.mask)};
 case 'ANF':return {coefficients:af(t)};
 case 'ALGEBRAIC_DEGREE':return {degree:Math.max(-1,...domain.filter(m=>anf(t,m)).map(count))};
 case 'MONOTONE':return {monotone:domain.every(a=>domain.every(b=>!subset(a,b)||t[a]<=t[b]))};
 case 'AFFINE':return {affine:domain.every(m=>count(m)<=1||anf(t,m)===0)};
 case 'SYMMETRIC':return {symmetric:domain.every(a=>domain.every(b=>count(a)!==count(b)||t[a]===t[b]))};
 case 'SELF_DUAL':return {selfDual:domain.every(m=>t[m]!==t[(1<<n)-1-m])};
 case 'SAT_WITNESS':return {mask:t.indexOf(1)<0?null:t.indexOf(1)};
 case 'FALSIFY_WITNESS':return {mask:t.indexOf(0)<0?null:t.indexOf(0)};
 case 'EQUIVALENT':return {equivalent:t.every((v,i)=>v===x.right[i])};
 case 'HAMMING':return {distance:t.filter((v,i)=>v!==x.right[i]).length};
 case 'NONLINEARITY':{let minimum=t.length;for(let slope=0;slope<(1<<n);slope++)for(let offset=0;offset<2;offset++){const d=domain.filter(m=>t[m]!== (parity(slope&m)^offset)).length;minimum=Math.min(minimum,d);}return {nonlinearity:minimum};}
 case 'CORRELATION_IMMUNITY_1':return {orderOne:variables(n).every(k=>coefficient(t,1<<k)===0)};
 default:throw Error('unknown reference '+tag);
 }
}
function rng(seed){let state=seed>>>0;return max=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)%max;};}
function inputFor(tag,i,r){const n=1+r(4),size=1<<n;let table=Array.from({length:size},()=>r(2));
 if(i%17===0)table=Array(size).fill(0);
 if(i%19===0)table=Array(size).fill(1);
 if(i%23===0)table=all(n).map(parity);
 if(i%29===0)table=all(n).map(m=>m&1);
 if(['EQUIVALENT','HAMMING'].includes(tag)){const right=i%7===0?table.slice():table.map(v=>r(3)?v:1-v);return {n,left:table,right};}
 if(['COFACTORS','RESTRICT_ZERO','RESTRICT_ONE','DERIVATIVE','DERIVATIVE_WEIGHT'].includes(tag))return {n,table,variable:r(n)};
 if(['EVALUATE','WALSH_COEFF'].includes(tag))return {n,table,mask:r(size)};
 return {n,table};
}
export function runBooleanBank({resolveLayer=getGaussLayer}={}){
 assert.equal(GAUSS_IMPLEMENTED_LAYERS.length,1000);
 const report={schemaVersion:1,subject:'GAUSS exact finite Boolean functions',seed:'0x6a91be37',oracle:'independent direct exhaustive truth tables, subset sums and affine-distance enumeration',registryOperators:1000,coveredOperators:0,validCases:0,passedValidCases:0,failedValidCases:0,invalidCases:0,passedInvalidRejections:0,failedInvalidRejections:0,operatorResults:[],failures:[],caseDigest:''};
 const digest=createHash('sha256');
 for(const [operator,tag] of TAGS.entries()){
 const layerId=id(tag,operator),layer=resolveLayer(layerId);assert.equal(typeof layer?.execute,'function',`missing operator ${layerId}`);
 const r=rng(Number.parseInt(createHash('sha256').update(layerId).digest('hex').slice(0,8),16)^0x6a91be37);
 const item={id:layerId,validCases:0,passed:0,failed:0,invalidCases:0,rejected:0,invalidAccepted:0};
 for(let i=0;i<100;i++){
 const input=inputFor(tag,i,r),expected=reference(tag,input);digest.update(JSON.stringify({id:layerId,i,input,expected}));item.validCases++;report.validCases++;
 let actual;
 try{actual=layer.execute(structuredClone(input));assert.deepStrictEqual(actual,expected);item.passed++;report.passedValidCases++;}
 catch(error){item.failed++;report.failedValidCases++;if(report.failures.length<20)report.failures.push({id:layerId,i,input,expected,actual:actual??null,reason:String(error)});}
 if(i===0){const key='table'in input?'table':'left';const invalid=[{...input,unexpected:true},{...input,n:6},{...input,[key]:[...input[key].slice(1),2]}];
 for(const [j,bad] of invalid.entries()){item.invalidCases++;report.invalidCases++;try{const out=layer.execute(structuredClone(bad));item.invalidAccepted++;report.failedInvalidRejections++;if(report.failures.length<20)report.failures.push({id:layerId,i:`invalid-${j}`,input:bad,actual:out,reason:'invalid accepted'});}catch{item.rejected++;report.passedInvalidRejections++;}}
 }
 }
 report.coveredOperators++;report.operatorResults.push(item);
 }
 report.untestedOperators=1000-report.coveredOperators;report.caseDigest=`sha256:${digest.digest('hex')}`;report.validPassRate=report.passedValidCases/report.validCases;report.invalidRejectionRate=report.passedInvalidRejections/report.invalidCases;return report;
}
