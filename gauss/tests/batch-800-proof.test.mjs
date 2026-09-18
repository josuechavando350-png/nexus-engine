import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {NEW_200_ADDITIONS,BATCH_700_ADDITIONS,BATCH_800_ADDITIONS} from '../core/batch-800-additions.mjs';
import * as sets from '../core/layers/batch-800-sets.mjs';
import * as trees from '../core/layers/batch-800-trees.mjs';
import * as intervals from '../core/layers/batch-800-intervals.mjs';
import * as poly from '../core/layers/batch-800-finite-polynomials.mjs';
import * as grid from '../core/layers/batch-800-grids.mjs';
import * as bits from '../core/layers/batch-800-bitwords.mjs';
import * as fn from '../core/layers/batch-800-functions.mjs';
import * as urn from '../core/layers/batch-800-urns.mjs';
import {executeOffline,hash} from '../scripts/batch-800-runner.mjs';
import {verify} from '../scripts/verify-batch-800.mjs';
const fixture=JSON.parse(await readFile(new URL('../fixtures/batch-601-800-problem.json',import.meta.url),'utf8'));
const prior=JSON.parse(await readFile(new URL('../fixtures/prior-400-ids.json',import.meta.url),'utf8'));
let seed=0x713b4e29;function random(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/2**32;}
const pick=n=>Math.floor(random()*n);
const biggcd=(a,b)=>{a=BigInt(a);b=BigInt(b);while(b){[a,b]=[b,a%b];}return a;};
const rational=(a,b)=>{a=BigInt(a);b=BigInt(b);const d=biggcd(a,b);return `${a/d}/${b/d}`;};
const perm=x=>{const a=x.slice();for(let i=a.length-1;i>0;i--){const j=pick(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;};
const choose=(n,k)=>{if(k<0||k>n)return 0n;let a=1n;for(let i=1;i<=k;i++)a=a*BigInt(n-i+1)/BigInt(i);return a;};

test('200 executable unique definitions in separate 100-operator packages, exactly 400 historic-new ID exclusions',()=>{
 assert.equal(prior.length,400);assert.equal(new Set(prior).size,400);
 assert.equal(BATCH_700_ADDITIONS.length,100);assert.equal(BATCH_800_ADDITIONS.length,100);
 assert.equal(NEW_200_ADDITIONS.length,200);assert.equal(new Set(NEW_200_ADDITIONS.map(x=>x.id)).size,200);
 assert.equal(new Set(NEW_200_ADDITIONS.map(x=>x.execute)).size,200);
 assert.deepEqual(fixture.tasks.map(x=>x.layerId),NEW_200_ADDITIONS.map(x=>x.id));
 for(const def of NEW_200_ADDITIONS){assert(!prior.includes(def.id),def.id);assert(Object.isFrozen(def));assert.equal(typeof def.execute,'function');assert.deepEqual(fixture.tasks.find(x=>x.layerId===def.id).input,def.input);assert.doesNotThrow(()=>def.execute(structuredClone(def.input)),def.id);}
});

test('set algebra vs independent mask oracles for random bounded subsets',()=>{
 for(let t=0;t<250;t++){const n=1+pick(10),a=Array.from({length:n},(_,i)=>i).filter(()=>pick(2)),b=Array.from({length:n},(_,i)=>i).filter(()=>pick(2)),x={n,a:perm(a),b:perm(b)};
  assert.deepEqual(sets.setUnion(x).elements,Array.from({length:n},(_,i)=>i).filter(i=>a.includes(i)||b.includes(i)));
  assert.deepEqual(sets.setIntersection(x).elements,a.filter(i=>b.includes(i)));
  assert.deepEqual(sets.setSymmetricDifference(x).elements,Array.from({length:n},(_,i)=>i).filter(i=>a.includes(i)!==b.includes(i)));
  assert.equal(sets.setSubset(x).subset,a.every(v=>b.includes(v)));
  assert.equal(sets.setHammingDistance(x).distance,a.filter(v=>!b.includes(v)).length+b.filter(v=>!a.includes(v)).length);
  const u=sets.setUnion(x).elements.length,i=sets.setIntersection(x).elements.length;
  if(u)assert.equal(sets.setJaccard(x).similarity,rational(i,u));
  assert.deepEqual(sets.setUnrankMask({n,mask:sets.setBitMask(x).mask}).elements,a);
 }
});

test('finite set cover and hitting set witnesses verified by exhaustive enumeration',()=>{
 for(let t=0;t<80;t++){const n=1+pick(6),f=Array.from({length:1+pick(7)},()=>Array.from({length:n},(_,i)=>i).filter(()=>pick(2))),x={n,family:f};
  const cover=sets.setCoverWitness(x),hit=sets.setTransversalWitness(x);let minC=Infinity,minH=Infinity,ways=0;
  for(let mask=0;mask<1<<f.length;mask++){const selected=f.filter((_,i)=>mask>>i&1),covered=new Set(selected.flat());if(covered.size===n){ways++;minC=Math.min(minC,selected.length);}}
  for(let mask=0;mask<1<<n;mask++){const s=Array.from({length:n},(_,i)=>i).filter(i=>mask>>i&1);if(f.every(e=>e.some(v=>s.includes(v))))minH=Math.min(minH,s.length);}
  assert.equal(cover.size,Number.isFinite(minC)?minC:null);assert.equal(Number(sets.setCoverCount(x).count),ways);assert.equal(hit.size,Number.isFinite(minH)?minH:null);
 }
});

test('tree rooted LCA and paths vs independent breadth-first oracle',()=>{
 for(let t=0;t<130;t++){const n=1+pick(16),edges=Array.from({length:n-1},(_,i)=>[i+1,pick(i+1)]),root=pick(n),x={n,root,edges},adj=Array.from({length:n},()=>[]);for(const [a,b]of edges){adj[a].push(b);adj[b].push(a);}const parent=Array(n).fill(-1),depth=Array(n).fill(-1),q=[root];depth[root]=0;for(let z=0;z<q.length;z++)for(const v of adj[q[z]])if(depth[v]===-1){depth[v]=depth[q[z]]+1;parent[v]=q[z];q.push(v);}
  assert.deepEqual(trees.rootedDepths(x).depths,depth);assert.deepEqual(trees.rootedParents(x).parents,parent);
  const a=pick(n),b=pick(n),start=[a],seen=new Set([a]),prev=Array(n).fill(-1);for(let z=0;z<start.length;z++)for(const v of adj[start[z]])if(!seen.has(v)){seen.add(v);prev[v]=start[z];start.push(v);}let path=[b];while(path[0]!==a)path.unshift(prev[path[0]]);
  assert.deepEqual(trees.rootedPath({tree:x,a,b}).vertices,path);assert.equal(trees.rootedDistance({tree:x,a,b}).distance,path.length-1);
  const sizes=trees.rootedSubtreeSizes(x).sizes;assert.equal(sizes[root],n);assert.equal(sizes.reduce((s,v)=>s+v,0),depth.reduce((s,v)=>s+v+1,0));
 }
});

test('interval sweep-line coverage, pairs, and room assignments vs integer slot counting',()=>{
 for(let t=0;t<200;t++){const n=pick(10),a=Array.from({length:n},()=>{const s=pick(15)-5;return [s,s+1+pick(7)];}),x={intervals:a};
 const slots=Array.from({length:28},(_,i)=>a.filter(([s,e])=>s<=i-6&&i-6<e).length);
 assert.equal(intervals.intervalUnionLength(x).length,slots.filter(v=>v>0).length);
 assert.equal(intervals.intervalMaximumOverlap(x).maximum,Math.max(0,...slots));
 assert.equal(intervals.intervalUniqueCoverage(x).length,slots.filter(v=>v===1).length);
 const assign=intervals.intervalRoomAssignment(x);assert.equal(assign.roomCount,Math.max(0,...slots));
 for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(assign.rooms[i]===assign.rooms[j])assert(a[i][1]<=a[j][0]||a[j][1]<=a[i][0]);
 }
});

test('prime-field polynomial division, multiplication, resultant, inverse, interpolation properties',()=>{
 const primes=[2,3,5,7,11,13];for(let t=0;t<200;t++){const p=primes[pick(primes.length)],a=Array.from({length:1+pick(5)},()=>pick(p)),b=Array.from({length:1+pick(5)},()=>pick(p));if(!b.some(Boolean))b[0]=1;const x={prime:p,left:a,right:b};const {quotient,remainder}=poly.fpDivision(x),product=poly.fpProduct({prime:p,left:quotient,right:b}).coefficients,recovered=poly.fpAdd({prime:p,left:product,right:remainder}).coefficients;
  assert.deepEqual(recovered,poly.fpNormalize({prime:p,coefficients:a}).coefficients);
  assert(remainder.length<poly.fpNormalize({prime:p,coefficients:b}).coefficients.length||remainder.length===1&&remainder[0]===0);
  const point=pick(p),prod=poly.fpProduct(x).coefficients;
  assert.equal(poly.fpEvaluation({prime:p,coefficients:prod,at:point}).value,poly.fpEvaluation({prime:p,coefficients:a,at:point}).value*poly.fpEvaluation({prime:p,coefficients:b,at:point}).value%p);
 }
 assert.equal(poly.fpResultant({prime:5,left:[4,1],right:[3,1]}).value,4);
 assert.equal(poly.fpDiscriminant({prime:5,coefficients:[1,0,1]}).value,1);
 for(const p of [3,5,7]){const points=Array.from({length:p},(_,i)=>i).slice(0,Math.min(p,4)),values=points.map(v=>(3*v*v+2*v+1)%p),coefficients=poly.fpInterpolation({prime:p,points,values}).coefficients;assert.deepEqual(poly.fpMultiEvaluation({prime:p,coefficients,points}).values,values);}
 const invertible=poly.fpInverseMod({prime:5,coefficients:[1,1],modulus:[2,0,1]});assert.equal(invertible.invertible,true);assert.deepEqual(poly.fpDivision({prime:5,left:poly.fpProduct({prime:5,left:[1,1],right:invertible.inverse}).coefficients,right:[2,0,1]}).remainder,[1]);
});

test('grid obstacle BFS, geometry and monotone path counts against separate small-grid enumeration',()=>{
 for(let t=0;t<135;t++){const h=1+pick(5),w=1+pick(5),cells=Array.from({length:h},()=>Array.from({length:w},()=>pick(3)?1:0)),x={cells};
  assert.equal(grid.gridActiveCount(x).count,cells.flat().reduce((s,v)=>s+v,0));
  const per=cells.flatMap((row,i)=>row.map((v,j)=>v?4-[[1,0],[-1,0],[0,1],[0,-1]].filter(([di,dj])=>cells[i+di]?.[j+dj]).length:0)).reduce((s,v)=>s+v,0);
  assert.equal(grid.gridPerimeter(x).perimeter,per);
  const from=[0,0],to=[h-1,w-1],dist=Array.from({length:h},()=>Array(w).fill(null)),q=[];if(cells[0][0]){dist[0][0]=0;q.push(from);}for(let z=0;z<q.length;z++){const [i,j]=q[z];for(const[di,dj]of [[1,0],[-1,0],[0,1],[0,-1]]){const r=i+di,c=j+dj;if(cells[r]?.[c]&&dist[r][c]===null){dist[r][c]=dist[i][j]+1;q.push([r,c]);}}}
  assert.equal(grid.gridShortestDistance({...x,start:from,end:to}).distance,dist[h-1][w-1]);
  function mono(i,j){if(!cells[i]?.[j])return 0;if(i===h-1&&j===w-1)return 1;return mono(i+1,j)+mono(i,j+1);}
  assert.equal(grid.gridMonotonePaths(x).count,String(mono(0,0)));
 }
});

test('bitword Gray inversion, rotations, rank, and Hamming identity on randomized 32-bit values',()=>{
 for(let t=0;t<500;t++){const w=1+pick(32),max=2**w,a=Math.floor(random()*max),b=Math.floor(random()*max),v={width:w,value:a},by={...v,k:pick(w)};
 assert.equal(bits.bitGrayDecode({width:w,value:bits.bitGrayEncode(v).value}).value,a);
 assert.equal(bits.bitRotateRight({width:w,value:bits.bitRotateLeft(by).value,k:by.k}).value,a);
 assert.equal(bits.bitPopcount(v).count,bits.bitOnePositions(v).positions.length);
 assert.equal(bits.bitHammingDistance({width:w,left:a,right:b}).distance,bits.bitPopcount({width:w,value:Number(BigInt(a)^BigInt(b))}).count);
 assert.equal(bits.bitRank({...v,k:w}).rank,bits.bitPopcount(v).count);
 }
});

test('endofunction orbit, powers and components against naive iteration',()=>{
 for(let t=0;t<150;t++){const n=1+pick(12),mapping=Array.from({length:n},()=>pick(n)),x={mapping},v=pick(n),k=pick(1000),orbit=fn.fnOrbit({...x,vertex:v}),path=[v],seen=new Set([v]);let at=v;while(!seen.has(mapping[at])){at=mapping[at];path.push(at);seen.add(at);}assert.deepEqual(orbit.walk,path);let ref=v;for(let z=0;z<k;z++)ref=mapping[ref];assert.equal(fn.fnKthIterate({...x,vertex:v,steps:k}).vertex,ref);
 assert.equal(fn.fnPower({...x,exponent:k}).mapping[v],ref);
 assert.equal(fn.fnCyclicVertices(x).vertices.length,fn.fnCycles(x).cycles.reduce((s,c)=>s+c.length,0));
 }
});

test('urn exact count distributions normalize, means match combinatorial identities, and modes maximize probabilities',()=>{
 for(let t=0;t<125;t++){const red=pick(9),blue=pick(9);if(!red&&!blue)continue;const draws=pick(red+blue+1),x={red,blue,draws},h=urn.urnWithoutReplacementDistribution(x).probabilities,b=urn.urnWithReplacementDistribution(x).probabilities;
 const denH=choose(red+blue,draws),denB=BigInt(red+blue)**BigInt(draws);
 assert.deepEqual(h,Array.from({length:draws+1},(_,k)=>rational(choose(red,k)*choose(blue,draws-k),denH)));
 assert.deepEqual(b,Array.from({length:draws+1},(_,k)=>rational(choose(draws,k)*BigInt(red)**BigInt(k)*BigInt(blue)**BigInt(draws-k),BigInt(denB))));
 assert.equal(urn.urnWithoutReplacementMean(x).mean,rational(draws*red,red+blue));
 assert.equal(urn.urnWithReplacementMean(x).mean,rational(draws*red,red+blue));
 const hm=urn.urnWithoutReplacementModes(x).values;assert(hm.every(k=>h.every(v=>Number(h[k].split('/')[0])/Number(h[k].split('/')[1])>=Number(v.split('/')[0])/Number(v.split('/')[1])-1e-12)));
 }
});

test('bounded inputs fail closed on invalid graphs, fields, urns, sets and bitwords',()=>{
 assert.throws(()=>trees.rootedDepths({n:3,root:0,edges:[[0,1],[0,1]]}),/distinct/);
 assert.throws(()=>sets.setUnion({n:4,a:[1,1],b:[2]}),/duplicate/);
 assert.throws(()=>intervals.intervalMerge({intervals:[[3,3]]}),/positive/);
 assert.throws(()=>poly.fpNormalize({prime:4,coefficients:[1]}),/prime/);
 assert.throws(()=>grid.gridComponentCount({cells:[[1,0],[1]]}),/array/);
 assert.throws(()=>bits.bitPopcount({width:8,value:256}),/safe integer/);
 assert.throws(()=>fn.fnFixedCount({mapping:[0,2]}),/safe integer/);
 assert.throws(()=>urn.urnWithoutReplacementMean({red:2,blue:1,draws:4}),/safe integer/);
});

test('SHA evidence replay rejects tampering even when attacker recomputes output and whole-report hashes',async()=>{
 const report=await executeOffline();assert.equal(report.executed,200);assert.deepEqual(await verify(report),{verified:true,executed:200,reportSha256:report.reportSha256});
 for(const i of [0,28,60,100,149,173,199]){const fake=structuredClone(report);fake.rows[i].output={...fake.rows[i].output,forgedResult:99};fake.rows[i].outputSha256=hash(fake.rows[i].output);const {reportSha256:ignored,...unsigned}=fake;void ignored;fake.reportSha256=hash(unsigned);await assert.rejects(verify(fake),/independent replay differs/);}
});
