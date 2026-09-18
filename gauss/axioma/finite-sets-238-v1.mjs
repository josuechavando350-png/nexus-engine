/* Mathematical reference via Set membership and independently enumerated index combinations. */
import {runBatchBank,seq,frac} from './batch-238-common.mjs';
const tags=['SET_UNION','SET_INTERSECTION','SET_DIFFERENCE','SET_SYMMETRIC_DIFFERENCE','SET_COMPLEMENT','SET_SUBSET','SET_PROPER_SUBSET','SET_DISJOINT','SET_EQUALITY','SET_CARTESIAN_PRODUCT','SET_POWER_SET','SET_K_SUBSETS','SET_JACCARD','SET_DICE','SET_HAMMING','SET_BITMASK','SET_UNRANK_MASK','SET_COVER_WITNESS','SET_COVER_COUNT','SET_PACKING_WITNESS','SET_INCIDENCE_MATRIX','SET_ELEMENT_FREQUENCIES','SET_TRANSVERSAL','SET_MAXIMAL_MEMBERS','SET_ANTICHAIN_CHECK'];
const families=new Set(tags.slice(17));
const sorted=s=>[...s].sort((a,b)=>a-b);
const subset=(a,b)=>a.every(v=>b.includes(v));
const combinations=a=>{const out=[[]];for(const x of a){const old=out.slice();for(const c of old)out.push([...c,x]);}return out.sort((a,b)=>a.length-b.length||rank(a)-rank(b));};
const rank=a=>a.reduce((v,k)=>v+2**k,0);
function input(tag,i,r){const n=1+i%6,base=seq(n),a=base.filter((_,v)=>i%9===0?false:i%9===1?true:r(2)===1),b=base.filter((_,v)=>i%7===0?false:i%7===1?true:r(2)===1);
 if(families.has(tag)){const length=i%11===0?0:1+r(8),family=seq(length).map((_,k)=>base.filter(v=>i%13===0?false:i%13===1?true:r(2)===1));return {n,family};}
 if(tag==='SET_UNRANK_MASK')return {n,mask:i%7===0?0:i%7===1?2**n-1:r(2**n)};
 const x={n,a,b};if(tag==='SET_K_SUBSETS')return {...x,k:i%6===0?0:i%6===1?a.length:r(a.length+1)};return x;
}
function reference(tag,x){const {n,a,b,family:f}=x;
 const A=new Set(a),B=new Set(b),common=a?.filter(v=>B.has(v))??[],union=sorted(new Set([...(a??[]),...(b??[])]));
 switch(tag){
 case 'SET_UNION':return {elements:union};
 case 'SET_INTERSECTION':return {elements:common};
 case 'SET_DIFFERENCE':return {elements:a.filter(v=>!B.has(v))};
 case 'SET_SYMMETRIC_DIFFERENCE':return {elements:union.filter(v=>A.has(v)!==B.has(v))};
 case 'SET_COMPLEMENT':return {elements:seq(n).filter(v=>!A.has(v))};
 case 'SET_SUBSET':return {subset:subset(a,b)};
 case 'SET_PROPER_SUBSET':return {proper:subset(a,b)&&a.length<b.length};
 case 'SET_DISJOINT':return {disjoint:common.length===0};
 case 'SET_EQUALITY':return {equal:subset(a,b)&&subset(b,a)};
 case 'SET_CARTESIAN_PRODUCT':return {pairs:a.flatMap(v=>b.map(w=>[v,w]))};
 case 'SET_POWER_SET':return {subsets:seq(2**a.length).map(m=>a.filter((_,k)=>Math.floor(m/2**k)%2))};
 case 'SET_K_SUBSETS':return {subsets:seq(2**a.length).map(m=>a.filter((_,k)=>Math.floor(m/2**k)%2)).filter(c=>c.length===x.k)};
 // Convention of the GAUSS contract: two empty sets have similarity one.
 case 'SET_JACCARD':return {similarity:union.length?frac(common.length,union.length):'1/1'};
 case 'SET_DICE':return {similarity:a.length+b.length?frac(2*common.length,a.length+b.length):'1/1'};
 case 'SET_HAMMING':return {distance:union.filter(v=>A.has(v)!==B.has(v)).length};
 case 'SET_BITMASK':return {mask:rank(a)};
 case 'SET_UNRANK_MASK':return {elements:seq(n).filter(k=>Math.floor(x.mask/2**k)%2)};
 case 'SET_COVER_WITNESS':{const winner=combinations(seq(f.length)).find(c=>seq(n).every(v=>c.some(j=>f[j].includes(v))));return {indices:winner??null,size:winner?.length??null};}
 case 'SET_COVER_COUNT':return {count:String(combinations(seq(f.length)).filter(c=>seq(n).every(v=>c.some(j=>f[j].includes(v)))).length)};
 case 'SET_PACKING_WITNESS':{const valid=combinations(seq(f.length)).filter(c=>seq(n).every(v=>c.filter(j=>f[j].includes(v)).length<=1)),size=Math.max(...valid.map(c=>c.length));const best=valid.filter(c=>c.length===size).sort((c,d)=>rank(c)-rank(d))[0];return {indices:best,size};}
 case 'SET_INCIDENCE_MATRIX':return {matrix:f.map(s=>seq(n).map(v=>Number(s.includes(v))))};
 case 'SET_ELEMENT_FREQUENCIES':return {frequencies:seq(n).map(v=>f.filter(s=>s.includes(v)).length)};
 case 'SET_TRANSVERSAL':{const best=combinations(seq(n)).find(c=>f.every(s=>s.some(v=>c.includes(v))));return {elements:best??null,size:best?.length??null};}
 case 'SET_MAXIMAL_MEMBERS':return {indices:seq(f.length).filter(i=>!seq(f.length).some(j=>i!==j&&subset(f[i],f[j])&&!subset(f[j],f[i])))};
 case 'SET_ANTICHAIN_CHECK':return {antichain:f.every((s,i)=>f.every((t,j)=>i===j||!subset(s,t)))};
 default:throw Error(`missing finite-set reference: ${tag}`);
 }
}
export const runFiniteSet238Bank=options=>runBatchBank({name:'AXIOMA finite sets 601-625',prefix:'MATH',start:601,tags,input,reference,...options});
