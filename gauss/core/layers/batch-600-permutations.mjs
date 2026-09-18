import {obj,int,arr,result,entries,factorial} from './batch-600-common.mjs';
function perm(input){obj(input,['permutation']);const p=arr(input.permutation,'permutation',1,9).map((v,i)=>int(v,`permutation[${i}]`,0,input.permutation.length-1));if(new Set(p).size!==p.length)throw new TypeError('permutation must be a bijection');return p;}
const p=x=>perm(x), pair=x=>{obj(x,['left','right']);const a=p(x.left),b=p(x.right);if(a.length!==b.length)throw new RangeError('permutation sizes differ');return [a,b];};
const cycles=x=>{const visited=new Set(),cs=[];for(let i=0;i<x.length;i++)if(!visited.has(i)){const c=[];for(let k=i;!visited.has(k);k=x[k]){visited.add(k);c.push(k);}cs.push(c);}return cs;};
const inv=x=>x.map((_,i)=>x.indexOf(i));
const compose=(a,b)=>a.map((_,i)=>a[b[i]]);
const pow=(a,n)=>{let r=a.map((_,i)=>i),base=n<0?inv(a):a,k=Math.abs(n);while(k){if(k%2)r=compose(base,r);k=Math.floor(k/2);if(k)base=compose(base,base);}return r;};
const gcd=(a,b)=>{while(b)[a,b]=[b,a%b];return a;};
const lcm=(a,b)=>a/gcd(a,b)*b;
const inversions=a=>{let z=0;for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++)if(a[i]>a[j])z++;return z;};
const desc=a=>a.slice(1).flatMap((v,i)=>a[i]>v?[i]:[]);
const code=a=>a.map((v,i)=>a.slice(i+1).filter(z=>z<v).length);
const rank=a=>code(a).reduce((s,v,i)=>s+BigInt(v)*factorial(a.length-i-1),0n);
function unrank(n,k){let r=k,available=Array.from({length:n},(_,i)=>i),a=[];for(let j=n;j>0;j--){const fac=factorial(j-1),q=Number(r/fac);r%=fac;a.push(available.splice(q,1)[0]);}return a;}
const reorder=(a,reverse)=>{const b=a.slice();let i=b.length-2;while(i>=0&&(reverse?b[i]<=b[i+1]:b[i]>=b[i+1]))i--;if(i<0)return null;let j=b.length-1;while(reverse?b[j]>=b[i]:b[j]<=b[i])j--;[b[i],b[j]]=[b[j],b[i]];const tail=b.splice(i+1).reverse();b.push(...tail);return b;};
export function inversePermutation(x){return result({permutation:inv(p(x))});}
export function composePermutations(x){const [a,b]=pair(x);return result({permutation:compose(a,b)});}
export function permutationPower(x){obj(x,['permutation','exponent']);const a=p({permutation:x.permutation});return result({permutation:pow(a,int(x.exponent,'exponent',-1000000,1000000))});}
export function cycleDecomposition(x){return result({cycles:cycles(p(x))});}
export function cycleType(x){return result({lengths:cycles(p(x)).map(c=>c.length).sort((a,b)=>b-a)});}
export function permutationOrder(x){return result({order:cycles(p(x)).reduce((v,c)=>lcm(v,c.length),1)});}
export function permutationSign(x){return result({sign:inversions(p(x))%2?-1:1});}
export function permutationInversions(x){return result({count:inversions(p(x))});}
export function majorIndex(x){return result({index:desc(p(x)).reduce((s,i)=>s+i+1,0)});}
export function descentIndices(x){return result({indices:desc(p(x))});}
export function ascentIndices(x){const a=p(x);return result({indices:a.slice(1).flatMap((v,i)=>a[i]<v?[i]:[])});}
export function fixedPoints(x){const a=p(x);return result({indices:a.flatMap((v,i)=>v===i?[i]:[])});}
export function excedanceIndices(x){const a=p(x);return result({indices:a.flatMap((v,i)=>v>i?[i]:[])});}
export function recordHighIndices(x){const a=p(x),indices=[];let high=-1;for(let i=0;i<a.length;i++)if(a[i]>high){indices.push(i);high=a[i];}return result({indices});}
export function permutationLehmerCode(x){return result({digits:code(p(x))});}
export function permutationRank(x){return result({rank:String(rank(p(x)))});}
export function permutationUnrank(x){obj(x,['size','rank']);const n=int(x.size,'size',1,9),limit=factorial(n);if(typeof x.rank!=='string'||!/^(0|[1-9][0-9]*)$/u.test(x.rank)||x.rank.length>12)throw new TypeError('rank must be a bounded canonical decimal string');const k=BigInt(x.rank);if(k>=limit)throw new RangeError('rank exceeds permutation count');return result({permutation:unrank(n,k)});}
export function nextPermutation(x){return result({permutation:reorder(p(x),false)});}
export function previousPermutation(x){return result({permutation:reorder(p(x),true)});}
export function permutationOrbit(x){obj(x,['permutation','point']);const a=p({permutation:x.permutation}),start=int(x.point,'point',0,a.length-1),orbit=[];for(let k=start;!orbit.includes(k);k=a[k])orbit.push(k);return result({orbit});}
export function conjugatePermutation(x){obj(x,['permutation','by']);const a=p({permutation:x.permutation}),b=p({permutation:x.by});if(a.length!==b.length)throw new RangeError('permutation sizes differ');return result({permutation:compose(compose(b,a),inv(b))});}
export function permutationCommutator(x){const [a,b]=pair(x);return result({permutation:compose(compose(compose(a,b),inv(a)),inv(b))});}
export function centralizerSize(x){const a=p(x),counts=new Map();for(const c of cycles(a))counts.set(c.length,(counts.get(c.length)??0)+1);let count=1n;for(const [length,m]of counts)count*=BigInt(length)**BigInt(m)*factorial(m);return result({size:String(count)});}
export function conjugacyClassSize(x){const a=p(x);return result({size:String(factorial(a.length)/BigInt(centralizerSize(x).size))});}
export function permutationCycleIndexMonomial(x){const a=p(x),freq=Array(a.length).fill(0);for(const c of cycles(a))freq[c.length-1]++;return result({exponents:freq});}
const s={permutation:[2,0,3,1]},t={permutation:[1,2,3,0]},both={left:s,right:t};
const defs=[
 ['PERM_INVERSE','Inverse of a finite bijection',inversePermutation,s],
 ['PERM_COMPOSE','Function composition of two finite bijections',composePermutations,both],
 ['PERM_POWER','Exponentiation of a permutation including inverse powers',permutationPower,{...s,exponent:-7}],
 ['PERM_CYCLE_DECOMP','Disjoint cycle decomposition with canonical starting vertices',cycleDecomposition,s],
 ['PERM_CYCLE_TYPE','Cycle-length integer partition of a permutation',cycleType,s],
 ['PERM_ORDER','Least positive exponent giving the identity',permutationOrder,s],
 ['PERM_SIGN','Sign of a permutation computed from inversion parity',permutationSign,s],
 ['PERM_INVERSIONS','Exact number of inversion pairs',permutationInversions,s],
 ['PERM_MAJOR_INDEX','Sum of one-based descent positions',majorIndex,s],
 ['PERM_DESCENTS','All adjacent descent positions',descentIndices,s],
 ['PERM_ASCENTS','All adjacent ascent positions',ascentIndices,s],
 ['PERM_FIXED_POINTS','All fixed points of a permutation',fixedPoints,s],
 ['PERM_EXCEDANCES','Positions where the image exceeds its argument',excedanceIndices,s],
 ['PERM_LEFT_RECORDS','Left-to-right record-maximum positions',recordHighIndices,s],
 ['PERM_LEHMER_CODE','Factoradic inversion-code digits',permutationLehmerCode,s],
 ['PERM_LEX_RANK','Exact zero-based lexicographic permutation rank',permutationRank,s],
 ['PERM_LEX_UNRANK','Factoradic unranking of a bounded permutation',permutationUnrank,{size:4,rank:'15'}],
 ['PERM_LEX_NEXT','Immediate lexicographic successor or null',nextPermutation,s],
 ['PERM_LEX_PREV','Immediate lexicographic predecessor or null',previousPermutation,s],
 ['PERM_POINT_ORBIT','Orbit of a specified point under iteration',permutationOrbit,{...s,point:0}],
 ['PERM_CONJUGATE','Conjugation by a second permutation',conjugatePermutation,{permutation:s.permutation,by:t.permutation}],
 ['PERM_COMMUTATOR','Group commutator a b a^-1 b^-1',permutationCommutator,both],
 ['PERM_CENTRALIZER_SIZE','Centralizer cardinality from cycle lengths',centralizerSize,s],
 ['PERM_CONJUGACY_CLASS','Conjugacy-class cardinality n! / centralizer size',conjugacyClassSize,s],
 ['PERM_CYCLE_INDEX_MONOMIAL','Cycle-index monomial exponents for all lengths',permutationCycleIndexMonomial,s]
];
export const PERMUTATIONS_600=entries(defs,'MATH','MATHEMATICS',526);
