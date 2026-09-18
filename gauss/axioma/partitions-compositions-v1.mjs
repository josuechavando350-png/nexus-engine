/* Independently enumerate cut patterns and Ferrers cells, without importing GAUSS partition code. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GAUSS_IMPLEMENTED_LAYERS,getGaussLayer} from '../core/registry.mjs';
const TAGS=['PART_K','PART_DISTINCT','PART_ODD','PART_EVEN','PART_MAX','PART_MIN','PART_EXACT_MAX','PART_ONES','PART_ENUM','PART_CONJUGATE','PART_DURFEE','PART_WEIGHT','PART_LENGTH','PART_MULTIPLICITY','PART_RANK','PART_HOOKS','PART_HOOK_PRODUCT','PART_STANDARD_TABLEAUX','PART_SELF_CONJUGATE','PART_SELF_CONJUGATE_COUNT','PART_DOMINANCE','COMP_POSITIVE','COMP_K','COMP_MAX','COMP_PALINDROMIC'];
const id=(t,i)=>`GAUSS.MATH.PARTITIONS_COMPOSITIONS.${t}.${826+i}`;
const weight=p=>p.reduce((a,b)=>a+b,0);
function compositions(n){if(n===0)return [[]];return Array.from({length:1<<(n-1)},(_,mask)=>{const a=[],last=n-1;let x=1;for(let i=0;i<last;i++){if(mask&(1<<i)){a.push(x);x=1;}else x++;}a.push(x);return a;});}
function partitions(n){const m=new Map();for(const c of compositions(n)){const sorted=c.slice().sort((a,b)=>b-a);m.set(JSON.stringify(sorted),sorted);}return [...m.values()].sort((a,b)=>{for(let i=0;i<Math.max(a.length,b.length);i++){if((a[i]??0)!==(b[i]??0))return (b[i]??0)-(a[i]??0);}return 0;});}
const cells=p=>p.flatMap((len,i)=>Array.from({length:len},(_,j)=>[i,j]));
const conjugate=p=>Array.from({length:p[0]??0},(_,j)=>p.filter(w=>w>j).length);
const hooks=p=>p.map((len,i)=>Array.from({length:len},(_,j)=>cells(p).filter(([r,c])=>r===i&&c>=j||c===j&&r>i).length));
const fact=n=>{let r=1n;for(let i=2;i<=n;i++)r*=BigInt(i);return r;};
const count=p=>({value:String(p.length)});
function reference(tag,x){const n=x.n,p=x.parts,P=n===undefined?null:partitions(n),C=n===undefined?null:compositions(n);
 switch(tag){
 case 'PART_K':return count(P.filter(a=>a.length===x.k));
 case 'PART_DISTINCT':return count(P.filter(a=>new Set(a).size===a.length));
 case 'PART_ODD':return count(P.filter(a=>a.every(v=>v%2===1)));
 case 'PART_EVEN':return count(P.filter(a=>a.every(v=>v%2===0)));
 case 'PART_MAX':return count(P.filter(a=>!a.length||a[0]<=x.max));
 case 'PART_MIN':return count(P.filter(a=>a.every(v=>v>=x.max)));
 case 'PART_EXACT_MAX':return count(P.filter(a=>a[0]===x.max));
 case 'PART_ONES':return count(P.filter(a=>a.filter(v=>v===1).length===x.k));
 case 'PART_ENUM':return {partitions:P};
 case 'PART_CONJUGATE':return {parts:conjugate(p)};
 case 'PART_DURFEE':return {size:cells(p).filter(([i,j])=>i===j).length};
 case 'PART_WEIGHT':return {sum:weight(p)};
 case 'PART_LENGTH':return {length:p.length};
 case 'PART_MULTIPLICITY':return {multiplicities:[...new Set(p)].sort((a,b)=>a-b).map(value=>({value,count:p.filter(v=>v===value).length}))};
 case 'PART_RANK':return {rank:(p[0]??0)-p.length};
 case 'PART_HOOKS':return {hooks:hooks(p)};
 case 'PART_HOOK_PRODUCT':return {value:String(hooks(p).flat().reduce((s,v)=>s*BigInt(v),1n))};
 case 'PART_STANDARD_TABLEAUX':return {value:String(fact(weight(p))/hooks(p).flat().reduce((s,v)=>s*BigInt(v),1n))};
 case 'PART_SELF_CONJUGATE':return {selfConjugate:JSON.stringify(p)===JSON.stringify(conjugate(p))};
 case 'PART_SELF_CONJUGATE_COUNT':return count(P.filter(a=>JSON.stringify(a)===JSON.stringify(conjugate(a))));
 case 'PART_DOMINANCE':{let a=0,b=0;for(let i=0;i<Math.max(x.left.length,x.right.length);i++){a+=x.left[i]??0;b+=x.right[i]??0;if(a<b)return {dominates:false};}return {dominates:true};}
 case 'COMP_POSITIVE':return count(C);
 case 'COMP_K':return count(C.filter(a=>a.length===x.k));
 case 'COMP_MAX':return count(C.filter(a=>a.every(v=>v<=x.max)));
 case 'COMP_PALINDROMIC':return count(C.filter(a=>a.every((v,i)=>v===a[a.length-1-i])));
 default:throw Error('unknown partition oracle '+tag);
 }
}
function rng(seed){let state=seed>>>0;return max=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)%max;};}
function inputFor(tag,i,r){const n=i%11===0?0:r(10),p=partitions(n)[r(partitions(n).length)];
 if(tag==='PART_DOMINANCE'){const other=partitions(n)[r(partitions(n).length)];return {left:p,right:other};}
 if(['PART_CONJUGATE','PART_DURFEE','PART_WEIGHT','PART_LENGTH','PART_MULTIPLICITY','PART_RANK','PART_HOOKS','PART_HOOK_PRODUCT','PART_STANDARD_TABLEAUX','PART_SELF_CONJUGATE'].includes(tag))return {parts:p};
 if(['PART_K','PART_ONES','COMP_K'].includes(tag))return {n,k:r(11)};
 if(['PART_MAX','PART_MIN','PART_EXACT_MAX','COMP_MAX'].includes(tag))return {n,max:1+r(10)};
 return {n};
}
export function runPartitionBank({resolveLayer=getGaussLayer}={}){
 assert.equal(GAUSS_IMPLEMENTED_LAYERS.length,1000);
 const report={schemaVersion:1,subject:'GAUSS exact partitions and compositions',seed:'0x145b117a',oracle:'complete cut-set composition enumeration, Ferrers cell counting, integer factorial identities',registryOperators:1000,coveredOperators:0,validCases:0,passedValidCases:0,failedValidCases:0,invalidCases:0,passedInvalidRejections:0,failedInvalidRejections:0,operatorResults:[],failures:[],caseDigest:''};
 const hash=createHash('sha256');
 for(const [index,tag]of TAGS.entries()){
 const layerId=id(tag,index),layer=resolveLayer(layerId);assert.equal(typeof layer?.execute,'function',`missing ${layerId}`);
 const r=rng(Number.parseInt(createHash('sha256').update(layerId).digest('hex').slice(0,8),16)^0x145b117a),item={id:layerId,validCases:0,passed:0,failed:0,invalidCases:0,rejected:0,invalidAccepted:0};
 for(let j=0;j<100;j++){
 const input=inputFor(tag,j,r),expected=reference(tag,input);hash.update(JSON.stringify({id:layerId,j,input,expected}));item.validCases++;report.validCases++;let actual;
 try{actual=layer.execute(structuredClone(input));assert.deepStrictEqual(actual,expected);item.passed++;report.passedValidCases++;}
 catch(error){item.failed++;report.failedValidCases++;if(report.failures.length<20)report.failures.push({id:layerId,j,input,expected,actual:actual??null,reason:String(error)});}
 if(j===0){const field='n'in input?'n':'parts'in input?'parts':'left',bad=[{...input,extra:1},{...input,[field]:'n'in input?15:[1,2]},{...input,[field]:'n'in input?1.5:[2,3]}];
 for(const [k,v]of bad.entries()){item.invalidCases++;report.invalidCases++;try{const out=layer.execute(structuredClone(v));item.invalidAccepted++;report.failedInvalidRejections++;if(report.failures.length<20)report.failures.push({id:layerId,j:`invalid-${k}`,input:v,actual:out,reason:'invalid accepted'});}catch{item.rejected++;report.passedInvalidRejections++;}}
 }
 }
 report.coveredOperators++;report.operatorResults.push(item);
 }
 report.untestedOperators=1000-report.coveredOperators;report.caseDigest=`sha256:${hash.digest('hex')}`;report.validPassRate=report.passedValidCases/report.validCases;report.invalidRejectionRate=report.passedInvalidRejections/report.invalidCases;return report;
}
