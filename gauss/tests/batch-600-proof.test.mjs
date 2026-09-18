import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BATCH_600_ADDITIONS} from '../core/batch-600-additions.mjs';
import * as po from '../core/layers/batch-600-posets.mjs';
import * as pe from '../core/layers/batch-600-permutations.mjs';
import * as hy from '../core/layers/batch-600-hypergraphs.mjs';
import * as ca from '../core/layers/batch-600-cellular.mjs';
import {executeBatch600,hash} from '../scripts/batch-600-runner.mjs';
import {verifyBatch600} from '../scripts/verify-batch-600.mjs';
let seed=0x9862ab91;function random(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;}
const pick=n=>Math.floor(random()*n);
const shuffled=n=>{const a=Array.from({length:n},(_,i)=>i);for(let i=n-1;i>0;i--){const j=pick(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;};
const factorial=n=>Array.from({length:n},(_,i)=>BigInt(i+1)).reduce((a,b)=>a*b,1n);
const pop=x=>{let z=0;while(x){z++;x&=x-1;}return z;};
const code=a=>a.reduce((s,v,i)=>s|(v<<i),0);
const bits=(v,n)=>Array.from({length:n},(_,i)=>v>>i&1);
const closure=(n,relations)=>{const r=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j));for(const[u,v]of relations)r[u][v]=true;for(let k=0;k<n;k++)for(let i=0;i<n;i++)for(let j=0;j<n;j++)if(r[i][k]&&r[k][j])r[i][j]=true;return r;};
const allPermutations=a=>{if(!a.length)return [[]];return a.flatMap((v,i)=>allPermutations(a.filter((_,j)=>j!==i)).map(t=>[v,...t]));};
const isLinear=(r,order)=>order.every((u,i)=>order.slice(0,i).every(v=>!r[u][v]));
const independent=(edges,s)=>edges.every(e=>(e&s)!==e);
const hitting=(edges,s)=>edges.every(e=>!!(e&s));

test('100 unique executable implementations, fixture coverage and 300 historic-new ID exclusions',async()=>{
 const prior=JSON.parse(await readFile(new URL('../fixtures/prior-300-ids.json',import.meta.url),'utf8'));
 const fixture=JSON.parse(await readFile(new URL('../fixtures/batch-600-problem.json',import.meta.url),'utf8'));
 assert.equal(prior.length,300);assert.equal(new Set(prior).size,300);assert.equal(BATCH_600_ADDITIONS.length,100);
 assert.equal(new Set(BATCH_600_ADDITIONS.map(x=>x.id)).size,100);assert.equal(new Set(BATCH_600_ADDITIONS.map(x=>x.execute)).size,100);
 assert.deepEqual(fixture.tasks.map(x=>x.layerId),BATCH_600_ADDITIONS.map(x=>x.id));
 for(const x of BATCH_600_ADDITIONS){assert(!prior.includes(x.id),`collision ${x.id}`);assert(Object.isFrozen(x));assert.equal(typeof x.execute,'function');assert.doesNotThrow(()=>x.execute(structuredClone(x.input)),x.id);}
});

test('poset closure, extension counts, ideal/antichain enumeration, width and Mobius-zeta inversion vs independent brute force',()=>{
 for(let trial=0;trial<100;trial++){
  const n=1+pick(6),order=shuffled(n),relations=[];
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(random()<0.37)relations.push([order[i],order[j]]);
  const x={size:n,relations},r=closure(n,relations),N=1<<n,ant=[],ideals=[];
  for(let m=0;m<N;m++){
   let ideal=true,anti=true;
   for(let i=0;i<n;i++)for(let j=0;j<n;j++)if(i!==j){if(m>>i&1&&r[j][i]&&!(m>>j&1))ideal=false;if(i<j&&(m>>i&1)&&(m>>j&1)&&(r[i][j]||r[j][i]))anti=false;}
   if(ideal)ideals.push(m);if(anti)ant.push(m);
  }
  const extensions=allPermutations(Array.from({length:n},(_,i)=>i)).filter(order=>isLinear(r,order));
  assert.deepEqual(po.transitiveClosure(x).matrix,r);
  assert.equal(Number(po.linearExtensionCount(x).count),extensions.length);
  assert.equal(Number(po.countOrderIdeals(x).count),ideals.length);
  assert.equal(Number(po.countAntichains(x).count),ant.length);
  assert.equal(po.maxAntichain(x).width,Math.max(...ant.map(pop)));
  assert.deepEqual(po.minLinearExtension(x).order,extensions[0]); // allPermutations is lexicographic
  assert.deepEqual(po.maxLinearExtension(x).order,extensions.at(-1));
  const values=Array.from({length:n},()=>pick(11)-5),z=po.zetaTransform({poset:x,values}).values.map(Number);
  assert.deepEqual(z,values.map((_,i)=>values.reduce((s,v,j)=>s+(r[j][i]?v:0),0)));
  assert.deepEqual(po.mobiusTransform({poset:x,values:z}).values.map(Number),values);
  for(let i=0;i<n;i++)for(let j=0;j<n;j++)if(r[i][j]){
   let sum=0n;for(let k=0;k<n;k++)if(r[i][k]&&r[k][j])sum+=BigInt(po.mobiusInterval({poset:x,a:i,b:k}).value);
   assert.equal(sum,i===j?1n:0n);
  }
 }
});

test('permutations: rank/unrank, inverse, composition, signs, orbit, centralizer over random bijections',()=>{
 for(let trial=0;trial<200;trial++){
  const n=1+pick(8),a=shuffled(n),b=shuffled(n),x={permutation:a};
  const r=BigInt(pe.permutationRank(x).rank);assert.deepEqual(pe.permutationUnrank({size:n,rank:String(r)}).permutation,a);
  assert(r>=0n&&r<factorial(n));
  const inverse=pe.inversePermutation(x).permutation;assert.deepEqual(a.map((_,i)=>a[inverse[i]]),a.map((_,i)=>i));
  assert.deepEqual(pe.composePermutations({left:x,right:{permutation:b}}).permutation,a.map((_,i)=>a[b[i]]));
  assert.deepEqual(pe.permutationPower({...x,exponent:-1}).permutation,inverse);
  const cycles=pe.cycleDecomposition(x).cycles;assert.equal(cycles.flat().length,n);
  assert.equal(Number(pe.permutationOrder(x).order)>0,true);
  assert.equal(pe.permutationSign(x).sign,Number(r%2n)===-1?0:(Number(pe.permutationInversions(x).count)%2?-1:1));
  assert.equal(BigInt(pe.centralizerSize(x).size)*BigInt(pe.conjugacyClassSize(x).size),factorial(n));
  const next=pe.nextPermutation(x).permutation;if(next)assert.equal(BigInt(pe.permutationRank({permutation:next}).rank),r+1n);
  else assert.equal(r,factorial(n)-1n);
  const prev=pe.previousPermutation(x).permutation;if(prev)assert.equal(BigInt(pe.permutationRank({permutation:prev}).rank),r-1n);
  else assert.equal(r,0n);
 }
});

test('hypergraphs: exact independent/transversal counts, witnesses, partition identity and two-colorings vs subsets',()=>{
 for(let trial=0;trial<130;trial++){
  const n=1+pick(7),candidate=Array.from({length:(1<<n)-1},(_,i)=>i+1),chosen=new Set();
  while(chosen.size<Math.min(10,candidate.length)&&random()<0.78)chosen.add(candidate[pick(candidate.length)]);
  const edges=[...chosen].map(m=>bits(m,n).flatMap((v,i)=>v?[i]:[])),x={vertexCount:n,edges};
  const ids=edges.map(e=>e.reduce((s,v)=>s|1<<v,0)),ind=[],hits=[],two=[];
  for(let s=0;s<1<<n;s++){
   if(independent(ids,s))ind.push(s);if(hitting(ids,s))hits.push(s);
   if(ids.every(e=>(e&s)!==0&&(e&~s)!==0))two.push(s);
  }
  assert.equal(Number(hy.independentSetCount(x).count),ind.length);
  assert.equal(Number(hy.hittingSetCount(x).count),hits.length);
  assert.equal(Number(hy.properTwoColoringCount(x).count),two.length);
  assert.equal(hy.twoColorable(x).twoColorable,two.length>0);
  assert.equal(hy.largestIndependentSet(x).size,Math.max(...ind.map(pop)));
  assert.equal(hy.minimumHittingSet(x).size,Math.min(...hits.map(pop)));
  assert.equal(ind.length,hits.length); // complement bijection
  assert.equal(hy.independentSetPolynomial(x).coefficients.reduce((s,v)=>s+BigInt(v),0n),BigInt(ind.length));
  assert.equal(hy.minimalHittingSets(x).sets.every(vertices=>{const s=vertices.reduce((v,i)=>v|1<<i,0);return hitting(ids,s)&&vertices.every(i=>!hitting(ids,s&~(1<<i)));}),true);
 }
});

test('cellular automata: independent periodic update oracle, preimage identity, cycles and symmetry for random rules',()=>{
 for(let trial=0;trial<180;trial++){
  const n=1+pick(7),rule=pick(256),s=Array.from({length:n},()=>pick(2)),x={rule,state:s},w={rule,width:n};
  const naive=v=>v.map((b,i)=>(rule>>((v[(i+n-1)%n]<<2)|(b<<1)|v[(i+1)%n]))&1);
  assert.deepEqual(ca.periodicStep(x).state,naive(s));
  const tr=Array.from({length:1<<n},(_,v)=>code(naive(bits(v,n))));
  const image=new Set(tr);
  assert.equal(ca.imageSize(w).size,image.size);
  assert.equal(ca.gardenOfEdenCount(w).count,(1<<n)-image.size);
  assert.equal(ca.injectivity(w).injective,image.size===(1<<n));
  assert.equal(ca.surjectivity(w).surjective,image.size===(1<<n));
  assert.equal(ca.fixedStateCount(w).count,tr.filter((v,i)=>v===i).length);
  assert.equal(ca.exactTwoCycleStates(w).count,tr.filter((v,i)=>v!==i&&tr[v]===i).length);
  const target=bits(pick(1<<n),n),pre=ca.preimageList({rule,width:n,target}).states;
  assert.equal(ca.preimageCount({rule,width:n,target}).count,pre.length);
  assert(pre.every(v=>code(naive(v))===code(target)));
  assert.equal(ca.basinSizes(w).basins.reduce((a,b)=>a+b.basinSize,0),1<<n);
  const orbit=ca.orbitStructure(x);assert.equal(orbit.preperiod+orbit.period,orbit.states.length);
  assert.equal(ca.periodicFinal({...x,steps:orbit.preperiod}).state.join(''),orbit.states[orbit.preperiod].join(''));
  const ref=ca.reflectRule({rule}).rule,comp=ca.complementRule({rule}).rule;
  const refStep=(v)=>v.map((b,i)=>(ref>>((v[(i+n-1)%n]<<2)|(b<<1)|v[(i+1)%n]))&1);
  const coStep=(v)=>v.map((b,i)=>(comp>>((v[(i+n-1)%n]<<2)|(b<<1)|v[(i+1)%n]))&1);
  assert.deepEqual(refStep(s),naive(s.slice().reverse()).reverse());
  assert.deepEqual(coStep(s),naive(s.map(v=>1-v)).map(v=>1-v));
 }
});

test('bad input fails closed on cycles, repeated edges, non-bijections and excessive enumeration width',()=>{
 assert.throws(()=>po.transitiveClosure({size:2,relations:[[0,1],[1,0]]}),/cycle/);
 assert.throws(()=>po.transitiveClosure({size:2,relations:[[0,1],[0,1]]}),/unique/);
 assert.throws(()=>pe.inversePermutation({permutation:[0,0]}),/bijection/);
 assert.throws(()=>pe.permutationUnrank({size:3,rank:'6'}),/exceeds/);
 assert.throws(()=>hy.hypergraphRank({vertexCount:3,edges:[[0,1],[1,0]]}),/duplicate hyperedge/);
 assert.throws(()=>ca.imageSize({rule:256,width:2}),/rule/);
 assert.throws(()=>ca.imageSize({rule:30,width:11}),/width/);
 assert.throws(()=>ca.periodicStep({rule:30,state:[1,2,1]}),/state/);
});

test('deterministic full replay and recalculated-hash forged output rejected',async()=>{
 const report=await executeBatch600();assert.equal(report.results.length,100);
 assert.deepEqual(await verifyBatch600(report),{verified:true,executed:100,reportSha256:report.reportSha256});
 const forged=structuredClone(report);forged.results[9].output={...forged.results[9].output,forged:true};forged.results[9].outputSha256=hash(forged.results[9].output);
 const {reportSha256:old,...unsigned}=forged;void old;forged.reportSha256=hash(unsigned);
 await assert.rejects(verifyBatch600(forged),/replay differs/);
});

test('poset order examples and inverted labels: covers, longest chains, Möbius interval and canonical principal sets',()=>{
 const chain={size:5,relations:[[4,2],[2,0],[0,3],[3,1]]};
 assert.deepEqual(po.hasseCover(chain).edges,[[0,3],[2,0],[3,1],[4,2]]);
 assert.deepEqual(po.longestChain(chain).chain,[4,2,0,3,1]);
 assert.equal(po.countOrderIdeals(chain).count,'6');
 assert.equal(po.countChains(chain).count,'32');
 assert.equal(po.maxAntichain(chain).width,1);
 assert.equal(po.mobiusInterval({poset:chain,a:4,b:1}).value,'0');
 assert.equal(po.mobiusInterval({poset:chain,a:2,b:0}).value,'-1');
 assert.deepEqual(po.principalIdeal({poset:chain,element:0}).elements,[0,2,4]);
 assert.deepEqual(po.principalFilter({poset:chain,element:0}).elements,[0,1,3]);
 assert.deepEqual(po.posetInterval({poset:chain,a:4,b:0}).elements,[0,2,4]);
 assert.equal(po.greatestElement(chain).element,1);
 assert.equal(po.leastElement(chain).element,4);
 assert.deepEqual(po.rankLevels(chain).levels,[2,4,1,3,0]);
 assert.deepEqual(po.corankLevels(chain).levels,[2,0,3,1,4]);
});

test('hyperedge matching, covering, incidence and deletion are independently checked by edge-mask enumeration',()=>{
 for(let trial=0;trial<125;trial++){
  const n=1+pick(6),all=[...Array((1<<n)-1)].map((_,i)=>i+1),m=Math.min(all.length,pick(9));
  const edges=shuffled(all.length).slice(0,m).map(i=>all[i]);
  const x={vertexCount:n,edges:edges.map(e=>bits(e,n).flatMap((v,i)=>v?[i]:[]))};
  let best=0,cover=null,count=0;
  for(let s=0;s<1<<m;s++){
   const e=edges.filter((_,i)=>s>>i&1),covered=e.reduce((a,b)=>a|b,0);
   if(e.every((z,i)=>e.slice(i+1).every(v=>!(z&v)))){count++;best=Math.max(best,e.length);}
   if(covered===(1<<n)-1&&(cover===null||e.length<cover))cover=e.length;
  }
  assert.equal(hy.maxEdgePacking(x).size,best);
  assert.equal(Number(hy.countEdgePackings(x).count),count);
  assert.equal(hy.minimumEdgeCover(x).count,cover);
  assert.equal(hy.vertexDegrees(x).degrees.reduce((a,b)=>a+b,0),edges.reduce((a,b)=>a+pop(b),0));
  assert.equal(hy.edgeSizeHistogram(x).counts.reduce((a,b)=>a+b,0),m);
  const matrix=hy.incidenceMatrix(x).matrix;assert.equal(matrix.length,n);assert.equal(matrix[0].length,m);
 }
});

test('CA rule 204 identity, rule 0 nilpotent and rule 170 periodic shift have exact finite dynamical invariants',()=>{
 for(let n=1;n<=8;n++){
  const identity={rule:204,width:n},zero={rule:0,width:n},shift={rule:170,width:n};
  assert.equal(ca.fixedStateCount(identity).count,1<<n);
  assert.equal(ca.gardenOfEdenCount(identity).count,0);
  assert.equal(ca.imageSize(zero).size,1);
  assert.equal(ca.gardenOfEdenCount(zero).count,(1<<n)-1);
  assert.equal(ca.finiteNumberConservation(identity).conserves,true);
  assert.equal(ca.finiteNumberConservation(shift).conserves,true);
  assert.equal(ca.injectivity(shift).injective,true);
  assert.equal(ca.surjectivity(shift).surjective,true);
 }
});
