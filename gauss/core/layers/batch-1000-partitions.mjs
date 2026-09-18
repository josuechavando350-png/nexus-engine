// Bounded integer-partition and ordered-composition combinatorics with exact integer counts.
import {object,arr,int,freeze,entries,choose} from './batch-1000-common.mjs';
const num=x=>{object(x,['n']);return int(x.n,'n',0,14);};
const spec=x=>{object(x,['n','k']);return [int(x.n,'n',0,14),int(x.k,'k',0,14)];};
const limit=x=>{object(x,['n','max']);return [int(x.n,'n',0,14),int(x.max,'max',1,14)];};
const part=x=>{object(x,['parts']);const p=arr(x.parts,'parts',0,14).map((v,i)=>int(v,`parts[${i}]`,1,40));if(p.some((v,i)=>i&&v>p[i-1])||p.reduce((s,v)=>s+v,0)>40)throw new TypeError('parts must be nonincreasing and total <=40');return p;};
const partitions=(n,filter=()=>true)=>{const out=[];function visit(rem,max,p){if(!rem){if(filter(p))out.push(p.slice());return;}for(let v=Math.min(max,rem);v>=1;v--){p.push(v);visit(rem-v,v,p);p.pop();}}visit(n,n,[]);return out;};
const compositions=n=>{if(n===0)return [[]];const out=[];function visit(rem,p){if(!rem){out.push(p.slice());return;}for(let v=1;v<=rem;v++){p.push(v);visit(rem-v,p);p.pop();}}visit(n,[]);return out;};
const val=x=>freeze({value:String(x)});
const conjugate=p=>Array.from({length:p[0]??0},(_,j)=>p.filter(v=>v>j).length);
const fact=n=>{let v=1n;for(let i=2;i<=n;i++)v*=BigInt(i);return v;};
const hooks=p=>p.map((v,i)=>Array.from({length:v},(_,j)=>v-j+p.slice(i+1).filter(w=>w>j).length));
export function partitionExactLength(x){const[n,k]=spec(x);return val(partitions(n,p=>p.length===k).length);}
export function partitionDistinctParts(x){return val(partitions(num(x),p=>new Set(p).size===p.length).length);}
export function partitionOddParts(x){return val(partitions(num(x),p=>p.every(v=>v%2===1)).length);}
export function partitionEvenParts(x){return val(partitions(num(x),p=>p.every(v=>v%2===0)).length);}
export function partitionBoundedLargest(x){const[n,k]=limit(x);return val(partitions(n,p=>!p.length||p[0]<=k).length);}
export function partitionBoundedSmallest(x){const[n,k]=limit(x);return val(partitions(n,p=>p.every(v=>v>=k)).length);}
export function partitionExactlyLargest(x){const[n,k]=limit(x);return val(partitions(n,p=>p[0]===k).length);}
export function partitionExactlyOnes(x){const[n,k]=spec(x);return val(partitions(n,p=>p.filter(v=>v===1).length===k).length);}
export function partitionEnumerate(x){return freeze({partitions:partitions(num(x))});}
export function partitionConjugate(x){return freeze({parts:conjugate(part(x))});}
export function partitionDurfee(x){const p=part(x);return freeze({size:p.filter((v,i)=>v>=i+1).length});}
export function partitionWeight(x){const p=part(x);return freeze({sum:p.reduce((s,v)=>s+v,0)});}
export function partitionLength(x){return freeze({length:part(x).length});}
export function partitionMultiplicity(x){const p=part(x),m=new Map();for(const v of p)m.set(v,(m.get(v)??0)+1);return freeze({multiplicities:[...m].sort((a,b)=>a[0]-b[0]).map(([value,count])=>({value,count}))});}
export function partitionRank(x){const p=part(x);return freeze({rank:(p[0]??0)-p.length});}
export function partitionHookLengths(x){return freeze({hooks:hooks(part(x))});}
export function partitionHookProduct(x){return val(hooks(part(x)).flat().reduce((p,v)=>p*BigInt(v),1n));}
export function partitionStandardTableaux(x){const p=part(x),n=p.reduce((s,v)=>s+v,0);return val(fact(n)/hooks(p).flat().reduce((v,k)=>v*BigInt(k),1n));}
export function partitionSelfConjugate(x){const p=part(x);return freeze({selfConjugate:JSON.stringify(p)===JSON.stringify(conjugate(p))});}
export function partitionCountSelfConjugate(x){return val(partitions(num(x),p=>JSON.stringify(p)===JSON.stringify(conjugate(p))).length);}
export function partitionDominance(x){object(x,['left','right']);const a=part({parts:x.left}),b=part({parts:x.right});if(a.reduce((s,v)=>s+v,0)!==b.reduce((s,v)=>s+v,0))throw new TypeError('dominance requires equal weight');let l=0,r=0;for(let i=0;i<Math.max(a.length,b.length);i++){l+=a[i]??0;r+=b[i]??0;if(l<r)return freeze({dominates:false});}return freeze({dominates:true});}
export function compositionPositiveCount(x){const n=num(x);return val(n===0?1n:2n**BigInt(n-1));}
export function compositionExactLength(x){const[n,k]=spec(x);return val(n===0&&k===0?1n:n>=k&&k>=1?choose(n-1,k-1):0n);}
export function compositionMaxPart(x){const[n,k]=limit(x);return val(compositions(n).filter(p=>p.every(v=>v<=k)).length);}
export function compositionPalindromeCount(x){return val(compositions(num(x)).filter(p=>p.every((v,i)=>v===p[p.length-i-1])).length);}
const P=[5,3,2,2],N={n:9};
const specs=[
 ['PART_K','Number of integer partitions with exactly k parts',partitionExactLength,{n:9,k:3}],
 ['PART_DISTINCT','Number of integer partitions with pairwise distinct parts',partitionDistinctParts,N],
 ['PART_ODD','Number of integer partitions into odd parts',partitionOddParts,N],
 ['PART_EVEN','Number of integer partitions into even parts',partitionEvenParts,{n:10}],
 ['PART_MAX','Number of integer partitions with maximum part bounded by k',partitionBoundedLargest,{n:9,max:4}],
 ['PART_MIN','Number of integer partitions with minimum part bounded below',partitionBoundedSmallest,{n:9,max:2}],
 ['PART_EXACT_MAX','Number of partitions with exactly specified largest part',partitionExactlyLargest,{n:9,max:4}],
 ['PART_ONES','Number of partitions with exactly k unit parts',partitionExactlyOnes,{n:9,k:2}],
 ['PART_ENUM','Enumerate nonincreasing integer partitions',partitionEnumerate,{n:8}],
 ['PART_CONJUGATE','Ferrers diagram conjugate integer partition',partitionConjugate,{parts:P}],
 ['PART_DURFEE','Size of Ferrers Durfee square',partitionDurfee,{parts:P}],
 ['PART_WEIGHT','Weight of an integer partition',partitionWeight,{parts:P}],
 ['PART_LENGTH','Number of parts of an integer partition',partitionLength,{parts:P}],
 ['PART_MULTIPLICITY','Multiplicity profile of integer partition parts',partitionMultiplicity,{parts:P}],
 ['PART_RANK','Largest-part minus number-of-parts partition rank',partitionRank,{parts:P}],
 ['PART_HOOKS','Hook length matrix of Ferrers cells',partitionHookLengths,{parts:P}],
 ['PART_HOOK_PRODUCT','Exact product of Ferrers cell hook lengths',partitionHookProduct,{parts:P}],
 ['PART_STANDARD_TABLEAUX','Exact standard Young tableaux count via hook-length identity',partitionStandardTableaux,{parts:P}],
 ['PART_SELF_CONJUGATE','Test conjugate symmetry of a Ferrers diagram',partitionSelfConjugate,{parts:[3,2,1]}],
 ['PART_SELF_CONJUGATE_COUNT','Count self-conjugate integer partitions of n',partitionCountSelfConjugate,N],
 ['PART_DOMINANCE','Test dominance order between equal-weight partitions',partitionDominance,{left:[5,3,2,2],right:[4,4,3,1]}],
 ['COMP_POSITIVE','Exact number of positive compositions of n',compositionPositiveCount,N],
 ['COMP_K','Exact number of positive compositions of fixed length k',compositionExactLength,{n:9,k:3}],
 ['COMP_MAX','Number of positive compositions with parts bounded above',compositionMaxPart,{n:9,max:3}],
 ['COMP_PALINDROMIC','Number of palindromic positive compositions',compositionPalindromeCount,N],
];
export const PARTITIONS_900=entries(specs,'MATH.PARTITIONS_COMPOSITIONS','MATHEMATICS',826);
