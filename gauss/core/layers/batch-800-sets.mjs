import {record,integer,array,uniqueInts,output,entries,range,rational} from './batch-800-common.mjs';
const S=x=>{record(x,['n','a','b']);const n=integer(x.n,'n',1,12);return {n,a:uniqueInts(x.a,n,'a'),b:uniqueInts(x.b,n,'b')};};
const F=x=>{record(x,['n','family']);const n=integer(x.n,'n',1,10);const f=array(x.family,'family',0,15).map((s,i)=>uniqueInts(s,n,`family[${i}]`));return {n,f};};
const mask=a=>a.reduce((s,v)=>s|1<<v,0),items=(n,m)=>range(n).filter(i=>m>>i&1),pop=m=>{let c=0;while(m){c++;m&=m-1;}return c;};
const sortedSet=s=>[...s].sort((a,b)=>a-b);
export function setUnion(x){const {a,b}=S(x);return output({elements:sortedSet(new Set([...a,...b]))});}
export function setIntersection(x){const {a,b}=S(x);return output({elements:a.filter(i=>b.includes(i))});}
export function setDifference(x){const {a,b}=S(x);return output({elements:a.filter(i=>!b.includes(i))});}
export function setSymmetricDifference(x){const {a,b}=S(x);return output({elements:sortedSet(new Set([...a.filter(i=>!b.includes(i)),...b.filter(i=>!a.includes(i))]))});}
export function setComplement(x){const {n,a}=S(x);return output({elements:range(n).filter(i=>!a.includes(i))});}
export function setSubset(x){const {a,b}=S(x);return output({subset:a.every(i=>b.includes(i))});}
export function setProperSubset(x){const {a,b}=S(x);return output({proper:a.length<b.length&&a.every(i=>b.includes(i))});}
export function setDisjoint(x){const {a,b}=S(x);return output({disjoint:a.every(i=>!b.includes(i))});}
export function setEquality(x){const {a,b}=S(x);return output({equal:a.length===b.length&&a.every((v,i)=>v===b[i])});}
export function setCartesianProduct(x){const {a,b}=S(x);return output({pairs:a.flatMap(i=>b.map(j=>[i,j]))});}
export function setPowerSet(x){const {a}=S(x);return output({subsets:range(1<<a.length).map(m=>a.filter((_,i)=>m>>i&1))});}
export function setFixedSizeSubsets(x){record(x,['n','a','b','k']);const {a}=S({n:x.n,a:x.a,b:x.b}),k=integer(x.k,'k',0,a.length);return output({subsets:range(1<<a.length).filter(m=>pop(m)===k).map(m=>a.filter((_,i)=>m>>i&1))});}
export function setJaccard(x){const {a,b}=S(x),u=new Set([...a,...b]);return output({similarity:u.size?rational(BigInt(a.filter(i=>b.includes(i)).length),BigInt(u.size)):'1/1'});}
export function setDiceCoefficient(x){const {a,b}=S(x);return output({similarity:a.length+b.length?rational(BigInt(2*a.filter(i=>b.includes(i)).length),BigInt(a.length+b.length)):'1/1'});}
export function setHammingDistance(x){const {a,b}=S(x);return output({distance:a.filter(i=>!b.includes(i)).length+b.filter(i=>!a.includes(i)).length});}
export function setBitMask(x){const {a}=S(x);return output({mask:mask(a)});}
export function setUnrankMask(x){record(x,['n','mask']);const n=integer(x.n,'n',1,12),m=integer(x.mask,'mask',0,(1<<n)-1);return output({elements:items(n,m)});}
export function setCoverWitness(x){const {n,f}=F(x),m=f.map(mask);let best=null;for(let s=0;s<1<<f.length;s++){let union=0;for(let i=0;i<f.length;i++)if(s>>i&1)union|=m[i];if(union===(1<<n)-1&&(best===null||pop(s)<best.length)){best=items(f.length,s);}}return output({indices:best,size:best?.length??null});}
export function setCoverCount(x){const {n,f}=F(x),m=f.map(mask);let c=0n;for(let s=0;s<1<<f.length;s++){let u=0;for(let i=0;i<f.length;i++)if(s>>i&1)u|=m[i];if(u===(1<<n)-1)c++;}return output({count:String(c)});}
export function setPackingWitness(x){const {f}=F(x),m=f.map(mask);let best=[];for(let s=0;s<1<<f.length;s++){let union=0,ok=true;for(let i=0;i<f.length;i++)if(s>>i&1){if(union&m[i]){ok=false;break;}union|=m[i];}if(ok&&pop(s)>best.length)best=items(f.length,s);}return output({indices:best,size:best.length});}
export function setIncidenceMatrix(x){const {n,f}=F(x);return output({matrix:f.map(s=>range(n).map(v=>Number(s.includes(v))))});}
export function setElementFrequencies(x){const {n,f}=F(x);return output({frequencies:range(n).map(v=>f.filter(s=>s.includes(v)).length)});}
export function setTransversalWitness(x){const {n,f}=F(x);let best=null;for(let m=0;m<1<<n;m++)if(f.every(s=>s.some(v=>m>>v&1))&&(best===null||pop(m)<best.length))best=items(n,m);return output({elements:best,size:best?.length??null});}
export function setMaximalMembers(x){const {f}=F(x),m=f.map(mask);return output({indices:range(f.length).filter(i=>!range(f.length).some(j=>j!==i&&m[i]!==m[j]&&(m[i]&m[j])===m[i]))});}
export function setAntichainCheck(x){const {f}=F(x),m=f.map(mask);return output({antichain:m.every((a,i)=>m.every((b,j)=>i===j||a!==b&&(a&b)!==a))});}
const sample={n:6,a:[0,2,4],b:[2,3,5]},family={n:5,family:[[0,1],[1,2,3],[3,4],[0,4]]};
const specs=[
['SET_UNION','Union of two finite integer sets',setUnion,sample],['SET_INTERSECTION','Intersection of two finite integer sets',setIntersection,sample],['SET_DIFFERENCE','Set-theoretic left difference',setDifference,sample],['SET_SYMMETRIC_DIFFERENCE','Symmetric difference of finite sets',setSymmetricDifference,sample],['SET_COMPLEMENT','Complement inside explicitly bounded universe',setComplement,sample],['SET_SUBSET','Non-strict subset relation',setSubset,sample],['SET_PROPER_SUBSET','Strict subset relation',setProperSubset,sample],['SET_DISJOINT','Disjointness decision of sets',setDisjoint,sample],['SET_EQUALITY','Equality independent of input order',setEquality,sample],['SET_CARTESIAN_PRODUCT','Lexicographic Cartesian product of two sets',setCartesianProduct,sample],['SET_POWER_SET','Enumerate every subset of a finite set',setPowerSet,sample],['SET_K_SUBSETS','Enumerate exact-cardinality subsets of a set',setFixedSizeSubsets,{...sample,k:2}],['SET_JACCARD','Exact rational Jaccard similarity',setJaccard,sample],['SET_DICE','Exact rational Sørensen-Dice coefficient',setDiceCoefficient,sample],['SET_HAMMING','Hamming distance between characteristic vectors',setHammingDistance,sample],['SET_BITMASK','Rank a finite subset by its characteristic mask',setBitMask,sample],['SET_UNRANK_MASK','Reconstruct subset from a bounded characteristic mask',setUnrankMask,{n:6,mask:21}],['SET_COVER_WITNESS','Exact minimum-cardinality set-cover witness',setCoverWitness,family],['SET_COVER_COUNT','Exact number of set-cover subfamilies',setCoverCount,family],['SET_PACKING_WITNESS','Maximum-cardinality disjoint set-family packing',setPackingWitness,family],['SET_INCIDENCE_MATRIX','Set-family incidence matrix',setIncidenceMatrix,family],['SET_ELEMENT_FREQUENCIES','Element incidence multiplicities across set family',setElementFrequencies,family],['SET_TRANSVERSAL','Minimum hitting set for a finite family',setTransversalWitness,family],['SET_MAXIMAL_MEMBERS','Inclusion-maximal members of an indexed family',setMaximalMembers,family],['SET_ANTICHAIN_CHECK','Pairwise inclusion-antichain check for set family',setAntichainCheck,family]
];
export const FINITE_SET_700=entries(specs,'MATH','MATHEMATICS',601);
