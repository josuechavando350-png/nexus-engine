import {obj,int,arr,result,entries,lexLess} from './batch-600-common.mjs';
function poset(input){
 obj(input,['size','relations']);const n=int(input.size,'size',1,9);const edges=arr(input.relations,'relations',0,72);
 const R=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j));const seen=new Set();
 for(const [k,p] of edges.entries()){arr(p,`relations[${k}]`,2,2);const u=int(p[0],'from',0,n-1),v=int(p[1],'to',0,n-1),key=`${u},${v}`;if(u===v||seen.has(key))throw new TypeError('irreflexive unique relations required');seen.add(key);R[u][v]=true;}
 for(let k=0;k<n;k++)for(let i=0;i<n;i++)for(let j=0;j<n;j++)R[i][j] ||= R[i][k]&&R[k][j];
 for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(R[i][j]&&R[j][i])throw new TypeError('relation contains a directed cycle');
 const preds=Array.from({length:n},(_,i)=>R.map((r,j)=>r[i]&&i!==j?j:-1).filter(j=>j>=0));
 return {n,R,preds};
}
const P=x=>poset(x),only=x=>{obj(x,['poset','element']);const p=P(x.poset);return [p,int(x.element,'element',0,p.n-1)];};
const ab=x=>{obj(x,['poset','a','b']);const p=P(x.poset);return [p,int(x.a,'a',0,p.n-1),int(x.b,'b',0,p.n-1)];};
const elems=(n,pred)=>Array.from({length:n},(_,i)=>i).filter(pred);
const subset=(p,m)=>elems(p.n,i=>!!(m>>i&1));
function antichain(p,m){for(let i=0;i<p.n;i++)for(let j=i+1;j<p.n;j++)if((m>>i&1)&&(m>>j&1)&&(p.R[i][j]||p.R[j][i]))return false;return true;}
function ideal(p,m){return elems(p.n,i=>m>>i&1).every(i=>p.preds[i].every(j=>m>>j&1));}
function ext(p){const N=1<<p.n,ways=Array(N).fill(0n);ways[0]=1n;for(let m=0;m<N;m++)if(ways[m])for(let i=0;i<p.n;i++)if(!(m>>i&1)&&p.preds[i].every(j=>m>>j&1))ways[m|1<<i]+=ways[m];return ways;}
function heights(p){const h=Array(p.n).fill(1);for(let k=0;k<p.n;k++)for(let i=0;i<p.n;i++)for(let j=0;j<p.n;j++)if(i!==j&&p.R[i][j]&&h[j]<h[i]+1)h[j]=h[i]+1;return h;}
function mu(p,a,b){
 if(!p.R[a][b])return 0n;
 const cache=new Map([[a,1n]]);
 function value(y){if(cache.has(y))return cache.get(y);let sum=0n;
  for(let z=0;z<p.n;z++)if(z!==y&&p.R[a][z]&&p.R[z][y])sum+=value(z);
  const m=-sum;cache.set(y,m);return m;
 }
 return value(b);
}
export function transitiveClosure(x){const p=P(x);return result({matrix:p.R});}
export function hasseCover(x){const p=P(x),edges=[];for(let i=0;i<p.n;i++)for(let j=0;j<p.n;j++)if(i!==j&&p.R[i][j]&&!elems(p.n,k=>k!==i&&k!==j&&p.R[i][k]&&p.R[k][j]).length)edges.push([i,j]);return result({edges});}
export function comparablePairs(x){const p=P(x);let count=0;for(let i=0;i<p.n;i++)for(let j=i+1;j<p.n;j++)if(p.R[i][j]||p.R[j][i])count++;return result({count});}
export function incomparablePairs(x){const p=P(x),pairs=[];for(let i=0;i<p.n;i++)for(let j=i+1;j<p.n;j++)if(!p.R[i][j]&&!p.R[j][i])pairs.push([i,j]);return result({pairs});}
export function minimalElements(x){const p=P(x);return result({elements:elems(p.n,i=>p.preds[i].length===0)});}
export function maximalElements(x){const p=P(x);return result({elements:elems(p.n,i=>!p.R[i].some((v,j)=>v&&i!==j))});}
export function leastElement(x){const p=P(x);return result({element:elems(p.n,i=>p.R[i].every(Boolean))[0]??null});}
export function greatestElement(x){const p=P(x);return result({element:elems(p.n,i=>p.R.every(r=>r[i]))[0]??null});}
export function longestChain(x){const p=P(x),dp=Array.from({length:p.n},(_,i)=>[i]);for(let t=0;t<p.n;t++)for(let i=0;i<p.n;i++)for(let j=0;j<p.n;j++)if(i!==j&&p.R[i][j]&&(dp[i].length+1>dp[j].length||dp[i].length+1===dp[j].length&&lexLess([...dp[i],j],dp[j])))dp[j]=[...dp[i],j];const chain=dp.reduce((best,c)=>c.length>best.length||c.length===best.length&&lexLess(c,best)?c:best,[]);return result({length:chain.length,chain});}
export function maxAntichain(x){const p=P(x);let best=[];for(let m=0;m<1<<p.n;m++)if(antichain(p,m)){const s=subset(p,m);if(s.length>best.length||s.length===best.length&&lexLess(s,best))best=s;}return result({width:best.length,antichain:best});}
export function countChains(x){const p=P(x);let count=1n;for(let m=1;m<1<<p.n;m++){const s=subset(p,m);if(s.every((i,k)=>s.slice(k+1).every(j=>p.R[i][j]||p.R[j][i])))count++;}return result({count:String(count)});}
export function countAntichains(x){const p=P(x);let count=0n;for(let m=0;m<1<<p.n;m++)if(antichain(p,m))count++;return result({count:String(count)});}
export function countOrderIdeals(x){const p=P(x);let count=0n;for(let m=0;m<1<<p.n;m++)if(ideal(p,m))count++;return result({count:String(count)});}
export function enumerateOrderIdeals(x){const p=P(x),ideals=[];for(let m=0;m<1<<p.n;m++)if(ideal(p,m))ideals.push(subset(p,m));return result({ideals});}
export function linearExtensionCount(x){const p=P(x);return result({count:String(ext(p).at(-1))});}
function greedy(p,descending){const remaining=new Set(elems(p.n,()=>true)),order=[];while(remaining.size){const available=[...remaining].filter(i=>p.preds[i].every(j=>!remaining.has(j))).sort((a,b)=>descending?b-a:a-b);const next=available[0];order.push(next);remaining.delete(next);}return order;}
export function minLinearExtension(x){return result({order:greedy(P(x),false)});}
export function maxLinearExtension(x){return result({order:greedy(P(x),true)});}
export function rankLevels(x){const p=P(x);return result({levels:heights(p).map(v=>v-1)});}
export function corankLevels(x){const p=P(x),rev={...p,R:p.R[0].map((_,i)=>p.R.map(r=>r[i]))};return result({levels:heights(rev).map(v=>v-1)});}
export function principalIdeal(x){const [p,a]=only(x);return result({elements:elems(p.n,i=>p.R[i][a])});}
export function principalFilter(x){const [p,a]=only(x);return result({elements:elems(p.n,i=>p.R[a][i])});}
export function posetInterval(x){const [p,a,b]=ab(x);return result({elements:elems(p.n,i=>p.R[a][i]&&p.R[i][b])});}
export function mobiusInterval(x){const [p,a,b]=ab(x);return result({value:String(mu(p,a,b))});}
export function zetaTransform(x){obj(x,['poset','values']);const p=P(x.poset),values=arr(x.values,'values',p.n,p.n).map((v,i)=>BigInt(int(v,`values[${i}]`,-100000,100000)));return result({values:values.map((_,i)=>String(values.reduce((s,v,j)=>s+(p.R[j][i]?v:0n),0n)))});}
export function mobiusTransform(x){obj(x,['poset','values']);const p=P(x.poset),values=arr(x.values,'values',p.n,p.n).map((v,i)=>BigInt(int(v,`values[${i}]`,-100000,100000)));return result({values:values.map((_,i)=>String(values.reduce((s,v,j)=>s+v*mu(p,j,i),0n)))});}
const sample={size:4,relations:[[0,2],[1,2],[2,3]]},pa={poset:sample,element:2},pb={poset:sample,a:0,b:3};
const definitions=[
 ['POSET_TRANSITIVE_CLOSURE','Reflexive transitive closure of a finite acyclic relation',transitiveClosure,sample],
 ['POSET_HASSE_COVER','Unique cover-edge representation of a finite poset',hasseCover,sample],
 ['POSET_COMPARABLE_PAIRS','Number of distinct unordered comparable element pairs',comparablePairs,sample],
 ['POSET_INCOMPARABLE_PAIRS','Complete list of incomparable unordered element pairs',incomparablePairs,sample],
 ['POSET_MINIMAL_ELEMENTS','All order-minimal elements',minimalElements,sample],
 ['POSET_MAXIMAL_ELEMENTS','All order-maximal elements',maximalElements,sample],
 ['POSET_LEAST','Least element existence and witness',leastElement,sample],
 ['POSET_GREATEST','Greatest element existence and witness',greatestElement,sample],
 ['POSET_HEIGHT','Maximum chain length with comparability witness',longestChain,sample],
 ['POSET_WIDTH','Maximum antichain by exhaustive bounded enumeration',maxAntichain,sample],
 ['POSET_CHAIN_COUNT','Exact number of chains including the empty chain',countChains,sample],
 ['POSET_ANTICHAIN_COUNT','Exact number of antichains including empty',countAntichains,sample],
 ['POSET_IDEAL_COUNT','Exact number of downward-closed subsets',countOrderIdeals,sample],
 ['POSET_ALL_IDEALS','Enumerate every order ideal of a bounded poset',enumerateOrderIdeals,sample],
 ['POSET_LINEAR_EXTENSIONS','Exact linear-extension count via subset dynamic programming',linearExtensionCount,sample],
 ['POSET_LEX_MIN_EXTENSION','Lexicographically minimum topological linear extension',minLinearExtension,sample],
 ['POSET_LEX_MAX_EXTENSION','Lexicographically maximum topological linear extension',maxLinearExtension,sample],
 ['POSET_RANK_LEVELS','Longest-chain distance from minimal elements',rankLevels,sample],
 ['POSET_CORANK_LEVELS','Longest-chain distance to maximal elements',corankLevels,sample],
 ['POSET_PRINCIPAL_IDEAL','All predecessors of an element including itself',principalIdeal,pa],
 ['POSET_PRINCIPAL_FILTER','All successors of an element including itself',principalFilter,pa],
 ['POSET_INTERVAL','Closed interval between two ordered poset elements',posetInterval,pb],
 ['POSET_MOBIUS_INTERVAL','Exact incidence-algebra Mobius function on an interval',mobiusInterval,pb],
 ['POSET_ZETA_TRANSFORM','Exact order-zeta sum over all predecessors',zetaTransform,{poset:sample,values:[1,2,3,4]}],
 ['POSET_MOBIUS_INVERSION','Exact Mobius inversion of cumulative order values',mobiusTransform,{poset:sample,values:[1,2,6,10]}]
];
export const POSETS_600=entries(definitions,'MATH','MATHEMATICS',501);
