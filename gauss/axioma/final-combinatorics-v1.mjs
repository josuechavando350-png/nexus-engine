/* Exhaustive labeled partitions, permutations, lattice words and integer compositions: no GAUSS recurrence imported. */
import {runFinalBank,range} from './final-common-v1.mjs';
const tags=['STIRLING_SECOND','STIRLING_FIRST_UNSIGNED','STIRLING_FIRST_SIGNED','BELL','ORDERED_BELL','LAH_UNSIGNED','EULERIAN','NARAYANA','CATALAN','MOTZKIN','DELANNOY','CENTRAL_DELANNOY','DERANGEMENT','RENCONTRES','INVOLUTION','PARTITIONS_EXACT_K','PARTITIONS_DISTINCT','PARTITIONS_ODD','POSITIVE_COMPOSITIONS','WEAK_COMPOSITIONS','PALINDROMIC_COMPOSITIONS','BINARY_NO_ADJACENT_ONES'];
const unary=new Set(['BELL','ORDERED_BELL','CATALAN','MOTZKIN','CENTRAL_DELANNOY','DERANGEMENT','INVOLUTION','PARTITIONS_DISTINCT','PARTITIONS_ODD','PALINDROMIC_COMPOSITIONS','BINARY_NO_ADJACENT_ONES']);
const count=(xs,predicate)=>BigInt(xs.filter(predicate).length);
const factorial=n=>range(n).reduce((a,i)=>a*BigInt(i+1),1n);
function permutations(n){const a=range(n),out=[];function go(i){if(i===n){out.push(a.slice());return;}for(let j=i;j<n;j++){[a[i],a[j]]=[a[j],a[i]];go(i+1);[a[i],a[j]]=[a[j],a[i]];}}go(0);return out;}
function partitions(n){let families=[[]];for(let v=0;v<n;v++){const next=[];for(const group of families){for(let j=0;j<group.length;j++){const copy=group.map(block=>block.slice());copy[j].push(v);next.push(copy);}next.push(group.concat([[v]]));}families=next;}return families;}
function integerPartitions(n){const out=[];function go(left,min,parts){if(!left){out.push(parts);return;}for(let j=min;j<=left;j++)go(left-j,j,parts.concat(j));}go(n,1,[]);return out;}
function compositions(n,k,allowZero){const out=[];function go(left,parts){if(parts.length===k){if(left===0)out.push(parts);return;}for(let j=allowZero?0:1;j<=left;j++)go(left-j,parts.concat(j));}go(n,[]);return out;}
function paths(n,k){let total=0n;function walk(a,b){if(a===n&&b===k){total++;return;}if(a<n)walk(a+1,b);if(b<k)walk(a,b+1);if(a<n&&b<k)walk(a+1,b+1);}walk(0,0);return total;}
function dyck(n){let all=0n,peaks=new Map();function walk(up,down,prev,peak){if(up===n&&down===n){all++;peaks.set(peak,(peaks.get(peak)??0n)+1n);return;}if(up<n)walk(up+1,down,'U',peak);if(down<up)walk(up,down+1,'D',peak+(prev==='U'?1:0));}walk(0,0,'',0);return {all,peaks};}
function motzkin(n){let total=0n;function walk(i,h){if(i===n){if(h===0)total++;return;}walk(i+1,h);walk(i+1,h+1);if(h>0)walk(i+1,h-1);}walk(0,0);return total;}
function run(tag,x){const {n,k}=x;let value;
 if(['STIRLING_SECOND','BELL','ORDERED_BELL','LAH_UNSIGNED'].includes(tag)){
 const pp=partitions(n);
 if(tag==='STIRLING_SECOND')value=count(pp,v=>v.length===k);
 if(tag==='BELL')value=BigInt(pp.length);
 if(tag==='ORDERED_BELL')value=pp.reduce((acc,v)=>acc+factorial(v.length),0n);
 if(tag==='LAH_UNSIGNED')value=pp.filter(v=>v.length===k).reduce((acc,v)=>acc+v.reduce((product,block)=>product*factorial(block.length),1n),0n);
 }else if(['STIRLING_FIRST_UNSIGNED','STIRLING_FIRST_SIGNED','EULERIAN','DERANGEMENT','RENCONTRES','INVOLUTION'].includes(tag)){
 const perms=permutations(n),cycles=v=>{let c=0;const seen=new Set();for(let i=0;i<n;i++)if(!seen.has(i)){c++;let j=i;while(!seen.has(j)){seen.add(j);j=v[j];}}return c;};
 const fixed=v=>v.filter((z,j)=>z===j).length;
 if(tag==='STIRLING_FIRST_UNSIGNED'||tag==='STIRLING_FIRST_SIGNED'){value=count(perms,v=>cycles(v)===k);if(tag==='STIRLING_FIRST_SIGNED'&&(n-k)%2)value=-value;}
 if(tag==='EULERIAN')value=count(perms,v=>v.slice(1).filter((z,j)=>v[j]>z).length===k);
 if(tag==='DERANGEMENT')value=count(perms,v=>fixed(v)===0);
 if(tag==='RENCONTRES')value=count(perms,v=>fixed(v)===k);
 if(tag==='INVOLUTION')value=count(perms,v=>v.every((z,j)=>v[z]===j));
 }else if(tag==='NARAYANA'||tag==='CATALAN'){const d=dyck(n);value=tag==='CATALAN'?d.all:(d.peaks.get(k)??0n);
 }else if(tag==='MOTZKIN')value=motzkin(n);
 else if(tag==='DELANNOY'||tag==='CENTRAL_DELANNOY')value=paths(n,tag==='CENTRAL_DELANNOY'?n:k);
 else if(['PARTITIONS_EXACT_K','PARTITIONS_DISTINCT','PARTITIONS_ODD'].includes(tag)){
 const pp=integerPartitions(n);
 value=count(pp,v=>tag==='PARTITIONS_EXACT_K'?v.length===k:tag==='PARTITIONS_DISTINCT'?new Set(v).size===v.length:v.every(z=>z%2===1));
 }else if(tag==='POSITIVE_COMPOSITIONS'||tag==='WEAK_COMPOSITIONS')value=BigInt(compositions(n,k,tag==='WEAK_COMPOSITIONS').length);
 else if(tag==='PALINDROMIC_COMPOSITIONS'){
 if(n===0)value=1n;else{let total=0n;for(let mask=0;mask<2**(n-1);mask++){let parts=[],size=1;for(let j=0;j<n-1;j++){if(mask>>j&1){parts.push(size);size=1;}else size++;}parts.push(size);if(parts.every((v,i)=>v===parts[parts.length-1-i]))total++;}value=total;}
 }else if(tag==='BINARY_NO_ADJACENT_ONES'){let total=0n;for(let mask=0;mask<2**n;mask++)if(!(mask&(mask<<1)))total++;value=total;}
 else throw Error('missing combinatorial enumeration '+tag);
 return {value:String(value)};
}
function sample(tag,i,r){const n=r(tag==='BINARY_NO_ADJACENT_ONES'?9:tag==='MOTZKIN'?7:6);return unary.has(tag)?{n}:{n,k:r(7)};}
const definitions=tags.map((tag,index)=>({id:`GAUSS.MATH.${tag}.${201+index}`,make:(i,r)=>sample(tag,i,r),reference:x=>run(tag,x)}));
export const runFinalCombinatoricsBank=options=>runFinalBank({name:'AXIOMA 22 independently enumerated labeled combinatorial families',definitions,...options});
