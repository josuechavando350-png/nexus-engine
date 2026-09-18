/* Reference binary relations by explicit pair sets and bounded walk enumeration. No GAUSS relation implementation imported. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GAUSS_IMPLEMENTED_LAYERS,getGaussLayer} from '../core/registry.mjs';
const TAGS=['DOMAIN','RANGE','CONVERSE','COMPLEMENT','IDENTITY','REFLEXIVE_CLOSURE','SYMMETRIC_CLOSURE','TRANSITIVE_CLOSURE','COMPOSITION','POWER','UNION','INTERSECTION','DIFFERENCE','SYMMETRIC_DIFFERENCE','IS_REFLEXIVE','IS_IRREFLEXIVE','IS_SYMMETRIC','IS_ANTISYMMETRIC','IS_TRANSITIVE','IS_EQUIVALENCE','EQUIVALENCE_CLASSES','RIGHT_UNIQUE','LEFT_UNIQUE','LEFT_TOTAL','RIGHT_TOTAL'];
const id=(tag,i)=>`GAUSS.CS.FINITE_RELATIONS.${tag}.${876+i}`;
const pair=(a,b)=>`${a},${b}`;
const membership=(s,a,b)=>s.has(pair(a,b));
const elems=n=>Array.from({length:n},(_,i)=>i);
const set=p=>new Set(p.map(([a,b])=>pair(a,b)));
const full=n=>elems(n).flatMap(a=>elems(n).map(b=>[a,b]));
const ordered=(n,p)=>full(n).filter(([a,b])=>membership(p,a,b));
const reflexive=(n,p)=>elems(n).every(a=>membership(p,a,a));
const symmetric=(n,p)=>ordered(n,p).every(([a,b])=>membership(p,b,a));
const transitive=(n,p)=>ordered(n,p).every(([a,b])=>ordered(n,p).every(([c,d])=>b!==c||membership(p,a,d)));
const equivalent=(n,p)=>reflexive(n,p)&&symmetric(n,p)&&transitive(n,p);
const composition=(n,p,q)=>set(full(n).filter(([a,b])=>elems(n).some(k=>membership(p,a,k)&&membership(q,k,b))));
function closure(n,p){const result=new Set(p);for(let length=1;length<=n;length++){
  // Every reachable pair admits a walk with at most n edges; include nonempty cycles.
  for(const start of elems(n)){let frontier=new Set([start]);for(let step=1;step<=length;step++){const next=new Set();for(const u of frontier)for(const v of elems(n))if(membership(p,u,v))next.add(v);frontier=next;}for(const v of frontier)result.add(pair(start,v));}
 }return result;}
function nth(n,p,exponent){if(exponent===0)return set(elems(n).map(i=>[i,i]));let paths=new Set(p);for(let i=1;i<exponent;i++)paths=composition(n,paths,p);return paths;}
function reference(tag,x){const n=x.size,a=set(x.pairs??x.left),b=set(x.right??[]),V=elems(n),all=full(n),emit=s=>({pairs:ordered(n,s)});
 switch(tag){
 case 'DOMAIN':return {elements:V.filter(i=>V.some(j=>membership(a,i,j)))};
 case 'RANGE':return {elements:V.filter(j=>V.some(i=>membership(a,i,j)))};
 case 'CONVERSE':return emit(set(ordered(n,a).map(([i,j])=>[j,i])));
 case 'COMPLEMENT':return emit(set(all.filter(([i,j])=>!membership(a,i,j))));
 case 'IDENTITY':return emit(set(V.map(i=>[i,i])));
 case 'REFLEXIVE_CLOSURE':return emit(new Set([...a,...V.map(i=>pair(i,i))]));
 case 'SYMMETRIC_CLOSURE':return emit(new Set([...a,...ordered(n,a).map(([i,j])=>pair(j,i))]));
 case 'TRANSITIVE_CLOSURE':return emit(closure(n,a));
 case 'COMPOSITION':return emit(composition(n,a,b));
 case 'POWER':return emit(nth(n,a,x.power));
 case 'UNION':return emit(new Set([...a,...b]));
 case 'INTERSECTION':return emit(new Set([...a].filter(k=>b.has(k))));
 case 'DIFFERENCE':return emit(new Set([...a].filter(k=>!b.has(k))));
 case 'SYMMETRIC_DIFFERENCE':return emit(new Set([...a,...b].filter(k=>a.has(k)!==b.has(k))));
 case 'IS_REFLEXIVE':return {reflexive:reflexive(n,a)};
 case 'IS_IRREFLEXIVE':return {irreflexive:V.every(i=>!membership(a,i,i))};
 case 'IS_SYMMETRIC':return {symmetric:symmetric(n,a)};
 case 'IS_ANTISYMMETRIC':return {antisymmetric:all.every(([i,j])=>i===j||!membership(a,i,j)||!membership(a,j,i))};
 case 'IS_TRANSITIVE':return {transitive:transitive(n,a)};
 case 'IS_EQUIVALENCE':return {equivalence:equivalent(n,a)};
 case 'EQUIVALENCE_CLASSES':{assert.ok(equivalent(n,a));const seen=new Set(),classes=[];for(const i of V)if(!seen.has(i)){const cls=V.filter(j=>membership(a,i,j));cls.forEach(j=>seen.add(j));classes.push(cls);}return {classes};}
 case 'RIGHT_UNIQUE':return {rightUnique:V.every(i=>V.filter(j=>membership(a,i,j)).length<=1)};
 case 'LEFT_UNIQUE':return {leftUnique:V.every(j=>V.filter(i=>membership(a,i,j)).length<=1)};
 case 'LEFT_TOTAL':return {leftTotal:V.every(i=>V.some(j=>membership(a,i,j)))};
 case 'RIGHT_TOTAL':return {rightTotal:V.every(j=>V.some(i=>membership(a,i,j)))};
 default:throw Error('unknown relation reference '+tag);
 }
}
function rng(seed){let state=seed>>>0;return max=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)%max;};}
function inputFor(tag,i,r){const size=1+r(5);let pairs=full(size).filter(()=>r(4)===0);
 if(i%11===0)pairs=[];
 if(i%13===0)pairs=elems(size).map(j=>[j,j]);
 if(tag==='EQUIVALENCE_CLASSES'){
  // Partition into blocks, then independently enumerate pairs in the same block.
  const groups=elems(size).map(v=>r(3));pairs=full(size).filter(([a,b])=>groups[a]===groups[b]);
 }
 if(['COMPOSITION','UNION','INTERSECTION','DIFFERENCE','SYMMETRIC_DIFFERENCE'].includes(tag))return {size,left:pairs,right:full(size).filter(()=>r(3)===0)};
 if(tag==='POWER')return {size,pairs,power:r(6)};
 return {size,pairs};
}
export function runFiniteRelationBank({resolveLayer=getGaussLayer}={}){
 assert.equal(GAUSS_IMPLEMENTED_LAYERS.length,1000);
 const report={schemaVersion:1,subject:'GAUSS finite binary relations',seed:'0x51de37ab',oracle:'independent pair-set algebra and brute-force path enumeration',registryOperators:1000,coveredOperators:0,validCases:0,passedValidCases:0,failedValidCases:0,invalidCases:0,passedInvalidRejections:0,failedInvalidRejections:0,operatorResults:[],failures:[],caseDigest:''};
 const digest=createHash('sha256');
 for(const [operator,tag] of TAGS.entries()){
 const layerId=id(tag,operator),layer=resolveLayer(layerId);assert.equal(typeof layer?.execute,'function',`missing operator ${layerId}`);
 const r=rng(Number.parseInt(createHash('sha256').update(layerId).digest('hex').slice(0,8),16)^0x51de37ab);
 const item={id:layerId,validCases:0,passed:0,failed:0,invalidCases:0,rejected:0,invalidAccepted:0};
 for(let i=0;i<100;i++){
 const input=inputFor(tag,i,r),expected=reference(tag,input);digest.update(JSON.stringify({id:layerId,i,input,expected}));item.validCases++;report.validCases++;
 let actual;
 try{actual=layer.execute(structuredClone(input));assert.deepStrictEqual(actual,expected);item.passed++;report.passedValidCases++;}
 catch(error){item.failed++;report.failedValidCases++;if(report.failures.length<20)report.failures.push({id:layerId,i,input,expected,actual:actual??null,reason:String(error)});}
 if(i===0){const key='pairs'in input?'pairs':'left';const invalid=[{...input,unexpected:true},{...input,size:11},{...input,[key]:[[0,0],[0,0]]}];
 for(const [j,bad] of invalid.entries()){item.invalidCases++;report.invalidCases++;try{const out=layer.execute(structuredClone(bad));item.invalidAccepted++;report.failedInvalidRejections++;if(report.failures.length<20)report.failures.push({id:layerId,i:`invalid-${j}`,input:bad,actual:out,reason:'invalid accepted'});}catch{item.rejected++;report.passedInvalidRejections++;}}
 }
 }
 report.coveredOperators++;report.operatorResults.push(item);
 }
 report.untestedOperators=1000-report.coveredOperators;report.caseDigest=`sha256:${digest.digest('hex')}`;report.validPassRate=report.passedValidCases/report.validCases;report.invalidRejectionRate=report.passedInvalidRejections/report.invalidCases;return report;
}
