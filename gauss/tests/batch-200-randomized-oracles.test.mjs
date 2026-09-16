import assert from 'node:assert/strict';
import test from 'node:test';
import * as signal from '../core/layers/signal-processing.mjs';
import * as poly from '../core/layers/polynomial-algebra.mjs';
import * as ar from '../core/layers/arithmetic-combinatorics.mjs';
import * as g from '../core/layers/graph-structural.mjs';
import * as info from '../core/layers/discrete-information.mjs';
const close=(x,y,tol=1e-7)=>assert(Math.abs(x-y)<=tol*Math.max(1,Math.abs(x),Math.abs(y)),`${x} vs ${y}`);
const rng=(()=>{let x=0x12345678;return ()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/2**32;};})();
const rand=(lo,hi)=>Math.floor(rng()*(hi-lo+1))+lo;
test('seeded cross-checked signal algebra integer graph and information cases',()=>{
let cases=0;
for(let n=1;n<=28;n++){const x=Array.from({length:n},()=>rand(-20,20));const X=signal.directDiscreteFourier({real:x,imaginary:Array(n).fill(0)});for(let k=0;k<n;k++){const y=signal.goertzelFrequencyBin({samples:x,bin:k});close(X.real[k],y.real);close(X.imaginary[k],y.imaginary);cases++;}}
for(let t=0;t<1000;t++){const p=Array.from({length:rand(1,5)},()=>rand(-9,9)),q=Array.from({length:rand(1,5)},()=>rand(-9,9));if(q.at(-1)===0)q[q.length-1]=1;const {quotient,remainder}=poly.realPolynomialLongDivision({dividend:p,divisor:q}),product=poly.polynomialConvolutionProduct({left:quotient,right:q}).coefficients;for(let i=0;i<Math.max(p.length,product.length,remainder.length);i++)close((product[i]??0)+(remainder[i]??0),p[i]??0);cases++;}
for(let t=0;t<500;t++){const p=Array.from({length:rand(1,6)},()=>rand(-3,3)),q=Array.from({length:rand(1,5)},()=>rand(-3,3)),x=rand(-2,2);if((p.length-1)*(q.length-1)>20)continue;const r=poly.polynomialComposition({outer:p,inner:q}).coefficients;close(r.reduceRight((z,c)=>z*x+c,0),p.reduceRight((z,c)=>z*q.reduceRight((a,b)=>a*x+b,0)+c,0));cases++;}
for(let n=1;n<=100;n++){const f=ar.exactDivisorSum({n}).sum,c=ar.exactDivisorCount({n}).count;let sum=0,count=0;for(let d=1;d<=n;d++)if(n%d===0){sum+=d;count++;}assert.equal(f,String(sum));assert.equal(c,count);cases++;}
for(let n=3;n<=199;n+=2){let prime=true;for(let k=2;k*k<=n;k++)if(n%k===0)prime=false;if(!prime)continue;for(let a=-n;a<=n;a++){const symbol=ar.jacobiSymbol({numerator:a,denominator:n}).symbol;const residue=((a%n)+n)%n;const r=residue===0?0:Array.from({length:n},(_,i)=>i*i%n).includes(residue)?1:-1;assert.equal(symbol,r,`Jacobi ${a}/${n}`);cases++;}}
for(let n=2;n<=7;n++){for(let sample=0;sample<100;sample++){const e=[];for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(rng()<0.4)e.push({from:i,to:j});const graph={vertexCount:n,edges:e},cores=g.undirectedCoreDecomposition(graph).coreNumbers;for(let k=0;k<n;k++){let remaining=new Set(Array.from({length:n},(_,i)=>i));for(;;){const drop=[...remaining].filter(v=>e.filter(({from,to})=>(from===v&&remaining.has(to))||(to===v&&remaining.has(from))).length<k);if(!drop.length)break;drop.forEach(v=>remaining.delete(v));}for(let v=0;v<n;v++)assert.equal(cores[v]>=k,remaining.has(v),`k-core n=${n} k=${k} v=${v}`);}cases++;}}
for(let n=2;n<=5;n++)for(let sample=0;sample<100;sample++){const edges=[];for(let u=0;u<n;u++)for(let v=0;v<n;v++)if(u!==v&&rng()<0.35)edges.push({from:u,to:v});const root=rand(0,n-1),got=BigInt(g.exactRootedOutArborescenceCount({vertexCount:n,edges,root}).arborescences),required=Array.from({length:n},(_,v)=>v).filter(v=>v!==root),incoming=required.map(v=>edges.filter(e=>e.to===v));let count=0n;const dfs=(i,ch)=>{if(i===required.length){const seen=new Set([root]);for(let it=0;it<n;it++)for(const {from,to} of ch)if(seen.has(from))seen.add(to);if(seen.size===n)count++;return;}for(const e of incoming[i])dfs(i+1,[...ch,e]);};dfs(0,[]);assert.equal(got,count,`arborescence n=${n}`);cases++;}
const entropy=p=>-(p*Math.log(p)+(1-p)*Math.log(1-p));for(const p of [0.1,0.2,0.3,0.4]){const c=info.discreteMemorylessChannelCapacity({transition:[[1-p,p],[p,1-p]]}).capacity;close(c,Math.log(2)-entropy(p),1e-8);cases++;}
assert.equal(cases,11505);
});
