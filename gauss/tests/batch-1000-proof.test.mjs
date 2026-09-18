import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {NEW_200_ADDITIONS,BATCH_900_ADDITIONS,BATCH_1000_ADDITIONS} from '../core/batch-1000-additions.mjs';
import * as s from '../core/layers/batch-1000-series.mjs';
import * as part from '../core/layers/batch-1000-partitions.mjs';
import * as bo from '../core/layers/batch-1000-boolean.mjs';
import * as rel from '../core/layers/batch-1000-relations.mjs';
import * as wt from '../core/layers/batch-1000-weighted-trees.mjs';
import * as mm from '../core/layers/batch-1000-modular-matrices.mjs';
import * as mc from '../core/layers/batch-1000-markov.mjs';
import * as pc from '../core/layers/batch-1000-prefix-codes.mjs';
import {canonical,hash,executeOffline} from '../scripts/batch-1000-runner.mjs';
import {verify} from '../scripts/verify-batch-1000.mjs';
const fixture=JSON.parse(await readFile(new URL('../fixtures/batch-801-1000-problem.json',import.meta.url),'utf8'));
const prior=JSON.parse(await readFile(new URL('../fixtures/prior-600-ids.json',import.meta.url),'utf8'));
let seed=0x9e3779b9;function random(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/0x100000000;}
const pick=n=>Math.floor(random()*n);
const big=(x)=>BigInt(x);
const frac=x=>{const[a,b]=x.split('/');return [BigInt(a),BigInt(b)];};
const equal=(a,b)=>{const [an,ad]=frac(a),[bn,bd]=frac(b);return an*bd===bn*ad;};
const exactIntegerPolynomial=a=>a.map(big);
const evalPoly=(a,x)=>a.reduceRight((sum,v)=>sum*x+v,0n);
const mulPoly=(a,b)=>Array.from({length:a.length+b.length-1},(_,k)=>a.reduce((v,x,i)=>v+(b[k-i]??0n)*x,0n));
const partitions=n=>{const out=[];function visit(k,upper,a){if(!k){out.push([...a]);return;}for(let v=Math.min(k,upper);v>=1;v--)visit(k-v,v,[...a,v]);}visit(n,n,[]);return out;};
const compositions=n=>{const out=[];function visit(k,a){if(!k){out.push(a);return;}for(let v=1;v<=k;v++)visit(k-v,[...a,v]);}visit(n,[]);return out;};
const bits=m=>{let c=0;while(m){c+=m&1;m>>=1;}return c;};
const sampleRel={size:3,pairs:[[0,1],[1,2],[2,0]]};

test('100 + 100 nonduplicate functions, real fixtures, and 600 prior-ID exclusions',()=>{
 assert.equal(prior.length,600);assert.equal(new Set(prior).size,600);
 assert.equal(BATCH_900_ADDITIONS.length,100);assert.equal(BATCH_1000_ADDITIONS.length,100);
 assert.equal(NEW_200_ADDITIONS.length,200);assert.equal(new Set(NEW_200_ADDITIONS.map(x=>x.id)).size,200);
 assert.equal(new Set(NEW_200_ADDITIONS.map(x=>x.execute)).size,200);
 assert.equal(new Set([...prior,...NEW_200_ADDITIONS.map(x=>x.id)]).size,800);
 assert.deepEqual(fixture.tasks.map(t=>t.layerId),NEW_200_ADDITIONS.map(x=>x.id));
 for(const [i,d] of NEW_200_ADDITIONS.entries()){
  assert.equal(d.id.split('.').at(-1),String(i+801));
  assert.equal(typeof d.execute,'function');assert(Object.isFrozen(d));
  assert.deepEqual(fixture.tasks[i].input,d.input);
  const copy=structuredClone(d.input),o=d.execute(copy);
  assert.equal(typeof o,'object');assert(o&&!Array.isArray(o)&&Object.keys(o).length);
  assert.equal(canonical(o),canonical(d.execute(structuredClone(d.input))));
  assert.deepEqual(copy,d.input,'operator mutates its input: '+d.id);
 }
});

test('rational series agree with independent integer polynomial arithmetic and formal identities',()=>{
 for(let k=0;k<150;k++){
  const a=Array.from({length:1+pick(6)},()=>pick(9)-4),b=Array.from({length:1+pick(6)},()=>pick(9)-4),x=pick(7)-3;
  const product=s.rationalSeriesProduct({left:a,right:b}).coefficients;
  const expectedProduct=mulPoly(exactIntegerPolynomial(a),exactIntegerPolynomial(b));while(expectedProduct.length>1&&expectedProduct.at(-1)===0n)expectedProduct.pop();
  assert.deepEqual(product.map(v=>frac(v)[0]/frac(v)[1]),expectedProduct);
  const actual=s.rationalSeriesEvaluate({coefficients:a,at:x}).value;
  assert(equal(actual,`${evalPoly(exactIntegerPolynomial(a),big(x))}/1`));
  const shift=pick(7)-3,z=s.rationalSeriesTranslate({coefficients:a,shift}).coefficients;
  const translated=s.rationalSeriesEvaluate({coefficients:z,at:x}).value;
  assert(equal(translated,`${evalPoly(exactIntegerPolynomial(a),big(x+shift))}/1`));
  const divisor=b.some(Boolean)?b:[1],{quotient,remainder}=s.rationalSeriesDivide({left:a,right:divisor});
  const recovered=s.rationalSeriesAdd({left:s.rationalSeriesProduct({left:quotient,right:divisor}).coefficients,right:remainder}).coefficients;
  assert.deepEqual(recovered,s.rationalSeriesNormalize({coefficients:a}).coefficients);
 }
 for(let k=0;k<100;k++){
  const a=[1,...Array.from({length:1+pick(4)},()=>pick(7)-3)],n=7;
  const r=s.rationalSeriesReciprocal({coefficients:a,count:n}).coefficients;
  const p=s.rationalSeriesTruncate({coefficients:s.rationalSeriesProduct({left:a,right:r}).coefficients,count:n}).coefficients;
  assert.deepEqual(p,['1/1']);
  const log=s.rationalSeriesFormalLog({coefficients:a,count:n}).coefficients;
  assert.deepEqual(s.rationalSeriesFormalExp({coefficients:log,count:n}).coefficients,s.rationalSeriesTruncate({coefficients:a,count:n}).coefficients);
 }
 assert.throws(()=>s.rationalSeriesReciprocal({coefficients:[0,1],count:3}),/constant/u);
 assert.throws(()=>s.rationalSeriesFormalLog({coefficients:[2,1],count:3}),/constant/u);
});

test('partition restrictions and composition counts match independent exhaustive recursion',()=>{
 for(let n=0;n<=11;n++){
  const all=partitions(n),comps=compositions(n);
  assert.deepEqual(part.partitionEnumerate({n}).partitions,all);
  assert.equal(part.partitionDistinctParts({n}).value,String(all.filter(p=>new Set(p).size===p.length).length));
  assert.equal(part.partitionOddParts({n}).value,String(all.filter(p=>p.every(v=>v%2)).length));
  assert.equal(part.partitionCountSelfConjugate({n}).value,String(all.filter(p=>JSON.stringify(p)===JSON.stringify(part.partitionConjugate({parts:p}).parts)).length));
  assert.equal(part.compositionPositiveCount({n}).value,String(comps.length));
  assert.equal(part.compositionPalindromeCount({n}).value,String(comps.filter(p=>p.every((v,i)=>v===p[p.length-i-1])).length));
  for(let k=0;k<=Math.min(n,4);k++)assert.equal(part.partitionExactLength({n,k}).value,String(all.filter(p=>p.length===k).length));
 }
 for(const p of [[5,3,2,2],[4,4,2],[3,2,1],[],[1,1,1,1]]){
  const c=part.partitionConjugate({parts:p}).parts;
  assert.deepEqual(part.partitionConjugate({parts:c}).parts,p);
  assert.equal(part.partitionWeight({parts:p}).sum,c.reduce((a,b)=>a+b,0));
 }
 assert.equal(part.partitionStandardTableaux({parts:[3,2]}).value,'5');
 assert.throws(()=>part.partitionConjugate({parts:[1,3]}),/nonincreasing/u);
});

test('Boolean Walsh Parseval, Mobius ANF and exact affine-distance oracle',()=>{
 for(let t=0;t<250;t++){
  const n=1+pick(4),N=1<<n,table=Array.from({length:N},()=>pick(2)),x={n,table};
  const spectrum=bo.booleanWalshSpectrum(x).spectrum;
  assert.equal(spectrum.reduce((v,w)=>v+w*w,0),N*N);
  const anf=bo.booleanAnf(x).coefficients;
  assert.deepEqual(table,Array.from({length:N},(_,mask)=>anf.reduce((v,a,m)=>((m&mask)===m?v^a:v),0)));
  assert.equal(bo.booleanAlgebraicDegree(x).degree,anf.reduce((v,a,m)=>a?Math.max(v,bits(m)):v,-1));
  const d=bo.booleanNonlinearity(x).nonlinearity;
  let best=N;for(let mask=0;mask<N;mask++)for(let b=0;b<=1;b++){
   let mismatches=0;for(let u=0;u<N;u++)if(table[u]!==((bits(mask&u)+b)%2))mismatches++;best=Math.min(best,mismatches);
  }
  assert.equal(d,best);
  const v=pick(n),co=bo.booleanCofactors({...x,variable:v});
  assert.deepEqual(bo.booleanDerivative({...x,variable:v}).table,co.zero.map((c,i)=>c^co.one[i]));
 }
 assert.throws(()=>bo.booleanWeight({n:2,table:[0,1]}),/length/u);
});

test('arbitrary relation composition, closure, powers and equivalence classes',()=>{
 for(let t=0;t<150;t++){
  const n=1+pick(6),a=[],b=[];
  for(let i=0;i<n;i++)for(let j=0;j<n;j++){if(pick(3)===0)a.push([i,j]);if(pick(3)===0)b.push([i,j]);}
  const A={size:n,pairs:a},map=p=>new Set(p.map(([i,j])=>`${i},${j}`));
  const comp=map(rel.relationComposition({size:n,left:a,right:b}).pairs);
  for(let i=0;i<n;i++)for(let j=0;j<n;j++){
   const expected=Array.from({length:n},(_,k)=>map(a).has(`${i},${k}`)&&map(b).has(`${k},${j}`)).some(Boolean);
   assert.equal(comp.has(`${i},${j}`),expected);
  }
  const closure=rel.relationTransitiveClosure(A).pairs,closed=map(closure);
  assert(rel.relationTransitive({size:n,pairs:closure}).transitive);
  for(const [i,j]of a)assert(closed.has(`${i},${j}`));
  assert.deepEqual(rel.relationPower({...A,power:2}).pairs,rel.relationComposition({size:n,left:a,right:a}).pairs);
 }
 const e={size:4,pairs:[[0,0],[1,1],[2,2],[3,3],[0,1],[1,0],[2,3],[3,2]]};
 assert.deepEqual(rel.relationEquivalenceClasses(e).classes,[[0,1],[2,3]]);
 assert.throws(()=>rel.relationEquivalenceClasses(sampleRel),/equivalence/u);
});

test('weighted tree distances, Wiener identity and threshold connectivity vs DFS oracle',()=>{
 for(let t=0;t<140;t++){
  const n=1+pick(12),edges=Array.from({length:n-1},(_,i)=>[i+1,pick(i+1),pick(20)]),x={n,root:pick(n),edges};
  const adj=Array.from({length:n},()=>[]);for(const[u,v,w]of edges){adj[u].push([v,w]);adj[v].push([u,w]);}
  function dfs(start,end,threshold=Infinity){const queue=[[start,0]],seen=new Set([start]);for(let k=0;k<queue.length;k++){const [u,d]=queue[k];if(u===end)return d;for(const[v,w]of adj[u])if(w<=threshold&&!seen.has(v)){seen.add(v);queue.push([v,d+w]);}}return null;}
  const d=wt.weightedTreeDistanceMatrix(x).distances.map(row=>row.map(Number));let total=0;
  for(let i=0;i<n;i++)for(let j=0;j<n;j++){assert.equal(d[i][j],dfs(i,j));if(i<j)total+=d[i][j];}
  assert.equal(wt.weightedTreeWienerIndex(x).index,String(total));
  assert.equal(wt.weightedTreeMedianVertices(x).vertices.every(i=>d[i].reduce((a,b)=>a+b,0)===Math.min(...d.map(r=>r.reduce((a,b)=>a+b,0)))),true);
  const threshold=pick(20),expected=Array.from({length:n},(_,i)=>Array.from({length:i},(_,j)=>dfs(i,j,threshold)!==null?1:0).reduce((a,b)=>a+b,0)).reduce((a,b)=>a+b,0);
  assert.equal(wt.weightedTreeThresholdPairCount({tree:x,threshold}).pairs,String(expected));
 }
 assert.throws(()=>wt.weightedTreeDiameter({n:3,root:0,edges:[[0,1,2],[0,1,3]]}),/duplicate/u);
});

test('finite-field elimination and characteristic polynomials satisfy independent algebraic identities',()=>{
 for(let t=0;t<175;t++){
  const p=[2,3,5,7,11][pick(5)],n=1+pick(4),a=Array.from({length:n},()=>Array.from({length:n},()=>pick(p))),x={prime:p,matrix:a};
  const {determinant:d}=mm.modMatrixDeterminant(x),{rank}=mm.modMatrixRank(x),{nullity}=mm.modMatrixNullity(x);
  assert.equal(rank+nullity,n);
  const kernel=mm.modMatrixKernel(x).basis;
  for(const v of kernel)for(const row of a)assert.equal(row.reduce((s,x,j)=>s+x*v[j],0)%p,0);
  assert.equal(kernel.length,nullity);
  const inv=mm.modMatrixInverse(x).inverse;
  assert.equal(inv!==null,d!==0);
  if(inv){const product=mm.modMatrixMultiply({prime:p,left:a,right:inv}).matrix;assert.deepEqual(product,Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>+(i===j))));}
  const coefficients=mm.modMatrixCharacteristic(x).coefficients;
  assert.equal(coefficients.length,n+1);assert.equal(coefficients[n],1);
  assert.equal(coefficients[0],((n%2?-d:d)%p+p)%p);
  for(let z=0;z<p;z++){
   const m=a.map((r,i)=>r.map((v,j)=>((i===j?z:0)-v+p)%p));
   const poly=coefficients.reduceRight((sum,v)=>(sum*z+v)%p,0);
   assert.equal(mm.modMatrixDeterminant({prime:p,matrix:m}).determinant,poly);
  }
  const vector=Array.from({length:n},()=>pick(p)),out=mm.modMatrixMultiply({prime:p,left:a,right:vector.map(v=>[v])}).matrix.map(r=>r[0]);
  const sol=mm.modMatrixSolve({prime:p,matrix:a,vector:out});assert.equal(sol.consistent,true);
  for(let i=0;i<n;i++)assert.equal(a[i].reduce((sum,v,j)=>sum+v*sol.solution[j],0)%p,out[i]);
  assert.equal(mm.modMatrixSolutionCount({prime:p,matrix:a,vector:out}).count,String(BigInt(p)**BigInt(nullity)));
 }
 assert.throws(()=>mm.modMatrixRank({prime:9,matrix:[[1]]}),/prime/u);
 assert.equal(mm.modMatrixConsistent({prime:2,matrix:[[0]],vector:[1]}).consistent,false);
});

test('exact Markov calculations agree with independent path enumeration and normalization',()=>{
 for(let t=0;t<100;t++){
  const n=2+pick(2),weights=Array.from({length:n},()=>Array.from({length:n},()=>pick(4)));for(const row of weights)if(!row.some(Boolean))row[0]=1;
  const start=pick(n),steps=pick(5),target=pick(n),x={weights,start,steps,target};
  const p=weights.map(row=>row.map(w=>w/row.reduce((a,b)=>a+b,0)));
  const dist=mc.markovStateDistribution({weights,start,steps}).distribution;
  assert(equal(dist.reduce((v,s)=>{const [a,b]=frac(s);return `${frac(v)[0]*b+a*frac(v)[1]}/${frac(v)[1]*b}`;},'0/1'),'1/1'));
  let hit=0,survive=0,exact2=0;function visit(v,k,prob,seen,visits){if(k===steps){if(seen)hit+=prob;else survive+=prob;if(visits===2)exact2+=prob;return;}for(let j=0;j<n;j++)visit(j,k+1,prob*p[v][j],seen||j===target,visits+(j===target));}
  visit(start,0,1,start===target,+(start===target));
  const number=r=>{const[a,b]=frac(r);return Number(a)/Number(b);};
  assert(Math.abs(number(mc.markovHitByHorizon(x).probability)-hit)<1e-12);
  assert(Math.abs(number(mc.markovSurvivalToHorizon(x).probability)-survive)<1e-12);
  assert(Math.abs(number(mc.markovExactVisits({...x,visits:2}).probability)-exact2)<1e-12);
 }
 assert.equal(mc.markovCandidateInvariant({weights:[[1,1],[1,1]],stationary:['1/2','1/2']}).invariant,true);
 assert.equal(mc.markovCandidateReversible({weights:[[1,1],[1,1]],stationary:['1/2','1/2']}).reversible,true);
 assert.deepEqual(mc.markovAbsorbingStates({weights:[[1,0],[1,0]]}).states,[0]);
 assert.throws(()=>mc.markovRationalTransition({weights:[[0,0],[1,1]]}),/positive/u);
});

test('binary prefix-code Kraft, symbol roundtrip, canonical lengths and Sardinas-Patterson',()=>{
 const base={symbols:['a','b','c','d'],codewords:['0','10','110','111']};
 assert.equal(pc.codePrefixFree(base).prefixFree,true);
 assert.equal(pc.codeKraftSum(base).sum,'1/1');
 assert.equal(pc.codeComplete(base).complete,true);
 assert.equal(pc.codeAverageLength({...base,frequencies:[8,4,2,2]}).average,'7/4');
 assert.equal(pc.codeLengthVariance({...base,frequencies:[8,4,2,2]}).variance,'11/16');
 assert.equal(pc.codeRedundancy({...base,frequencies:[8,4,2,2]}).bits,0);
 assert.equal(pc.codeUniquelyDecodable({symbols:['a','b','c'],codewords:['0','01','1']}).uniquelyDecodable,false);
 assert.equal(pc.codeUniquelyDecodable({symbols:['a','b'],codewords:['0','01']}).uniquelyDecodable,true);
 for(let i=0;i<120;i++){
  const symbols=['a','b','c','d','😀'],message=Array.from({length:pick(35)},()=>symbols[pick(5)]).join(''),wordbook={symbols,codewords:['00','01','10','110','111']};
  const bits=pc.codeEncode({...wordbook,message}).bits;
  assert.equal(pc.codeDecode({...wordbook,bits}).message,message);
  const lengths=wordbook.codewords.map(w=>w.length),canonical=pc.codeCanonicalFromLengths({symbols,lengths}).codewords;
  assert.equal(pc.codePrefixFree({symbols,codewords:canonical}).prefixFree,true);
  assert.equal(pc.codeKraftSum({symbols,codewords:canonical}).sum,pc.codeKraftSum(wordbook).sum);
 }
 assert.throws(()=>pc.codeDecode({...base,bits:'11'}),/incomplete/u);
 assert.throws(()=>pc.codeCanonicalFromLengths({symbols:['a','b','c'],lengths:[1,1,1]}),/Kraft/u);
});

test('all 200 outputs replay deterministically and forged SHA-256 output evidence is rejected',async()=>{
 const report=await executeOffline();assert.equal(report.rows.length,200);assert.equal(report.failed,0);
 assert.equal((await verify(report)).verified,true);
 for(const i of [0,21,57,84,103,141,163,199]){
  const forged=structuredClone(report);forged.rows[i].output={...forged.rows[i].output,fake:true};forged.rows[i].outputSha256=hash(forged.rows[i].output);
  const unsigned={...forged};delete unsigned.reportSha256;forged.reportSha256=hash(unsigned);
  await assert.rejects(verify(forged),/replayed output differs/u);
 }
});

test('bounded malformed inputs are rejected across all eight families',()=>{
 assert.throws(()=>s.rationalSeriesNormalize({coefficients:[1],extraneous:true}),/exactly/u);
 assert.throws(()=>s.rationalSeriesDivide({left:[1],right:[0]}),/zero polynomial/u);
 assert.throws(()=>s.rationalSeriesNormalize({coefficients:['1/0']}),/invalid rational/u);
 assert.throws(()=>part.partitionEnumerate({n:16}),/outside/u);
 assert.throws(()=>part.partitionHookLengths({parts:[40,2,1,1]}),/total/u);
 assert.throws(()=>bo.booleanBalanced({n:2,table:[0,2,1,0]}),/outside/u);
 assert.throws(()=>rel.relationDomain({size:2,pairs:[[0,1],[0,1]]}),/repeated/u);
 assert.throws(()=>wt.weightedTreeRootDistances({n:3,root:0,edges:[[0,1,1],[1,2,-1]]}),/outside/u);
 assert.throws(()=>mm.modMatrixRank({prime:97,matrix:[[1,2],[1]]}),/length/u);
 assert.throws(()=>mc.markovRationalTransition({weights:[[1,1],[1,-1]]}),/outside/u);
 assert.throws(()=>pc.codePrefixFree({symbols:['a','a'],codewords:['0','1']}),/unique/u);
 assert.throws(()=>pc.codeEncode({symbols:['a'],codewords:['0'],message:'b'}),/unknown/u);
});

test('exact Markov first-passage conservation, set probabilities, and visit generating identity',()=>{
 const weights=[[3,1,0],[2,1,1],[1,1,2]];
 for(let t=0;t<60;t++){
  const steps=pick(7),start=pick(3),target=pick(3),x={weights,start,steps,target};
  const first=mc.markovFirstHitDistribution(x).probabilities;
  const prob=mc.markovHitByHorizon(x).probability,remain=mc.markovSurvivalToHorizon(x).probability;
  const n=r=>{const[a,b]=frac(r);return Number(a)/Number(b);};
  assert(Math.abs(first.reduce((s,v)=>s+n(v),0)-n(prob))<1e-12);
  assert(Math.abs(n(prob)+n(remain)-1)<1e-12);
  assert(Math.abs(Array.from({length:steps+2},(_,visits)=>n(mc.markovExactVisits({...x,visits}).probability)).reduce((a,b)=>a+b,0)-1)<1e-12);
  assert(Math.abs(n(mc.markovSetHit({weights,start,steps,targets:[target]}).probability)-n(prob))<1e-12);
  assert(Math.abs(n(mc.markovSetStay({weights,start,steps,allowed:[0,1,2]}).probability)-1)<1e-12);
 }
});

test('exact Markov visits includes initial state plus all twelve transitions',()=>{
 const x={weights:[[1]],start:0,steps:12,target:0};
 assert.deepEqual(mc.markovExactVisits({...x,visits:13}),{probability:'1/1'});
 assert.deepEqual(mc.markovExactVisits({...x,visits:12}),{probability:'0/1'});
 assert.throws(()=>mc.markovExactVisits({...x,visits:14}),/visits outside/u);
});

test('unambiguous non-prefix binary codebooks preserve independently enumerated small messages',()=>{
 const alphabet=['a','b','c'];let checked=0;
 for(let i=0;i<70;i++){
  const pool=['0','1','00','01','10','11','000','001','010','011','100','101','110','111'],codes=[];
  while(codes.length<3){const c=pool[pick(pool.length)];if(!codes.includes(c))codes.push(c);}
  const result=pc.codeUniquelyDecodable({symbols:alphabet,codewords:codes}).uniquelyDecodable;
  const found=new Map();let ambiguity=false;
  for(let n=1;n<=5;n++)for(let mask=0;mask<3**n;mask++){
   let x=mask,msg='',bit='';for(let j=0;j<n;j++){const digit=x%3;x=Math.floor(x/3);msg+=alphabet[digit];bit+=codes[digit];}
   if(found.has(bit)&&found.get(bit)!==msg)ambiguity=true;else found.set(bit,msg);
  }
  if(ambiguity)assert.equal(result,false,`ambiguous codebook incorrectly classified: ${codes}`);
  checked++;
 }
 assert.equal(checked,70);
});
