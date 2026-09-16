import test from 'node:test';
import assert from 'node:assert/strict';
import {
 undirectedConnectedComponents,bipartiteGraphColoring,exactSpanningTreeCount,
 exactTopologicalOrderCount,exactMaximumClique,exactMinimumDominatingSet,
 exactProperColoringCount,exactHamiltonianPath,exactSimplePathCount,
 exactWalkCount,exactGeneralMaximumMatching,exactGraphGirth,
} from '../core/layers/graph-combinatorics.mjs';
let seed=0x317cabcd;function rand(n){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)%n;}
function undirected(n){const edges=[];for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(rand(3)===0)edges.push({from:i,to:j});return {vertexCount:n,edges};}
function directed(n){const edges=[];for(let i=0;i<n;i++)for(let j=0;j<n;j++)if(i!==j&&rand(4)===0)edges.push({from:i,to:j});return {vertexCount:n,edges};}
function connectivity(n,edges){const adj=Array.from({length:n},()=>[]);for(const {from,to} of edges){adj[from].push(to);adj[to].push(from);}const seen=new Set(),groups=[];for(let i=0;i<n;i++)if(!seen.has(i)){const q=[i];seen.add(i);for(let k=0;k<q.length;k++)for(const j of adj[q[k]])if(!seen.has(j)){seen.add(j);q.push(j);}groups.push(q.sort((a,b)=>a-b));}return groups;}
const permutations=xs=>xs.length?xs.flatMap((v,i)=>permutations(xs.filter((_,j)=>j!==i)).map(p=>[v,...p])):[[]];
test('undirected components match independently traversed connected partitions in 220 graphs',()=>{
 for(let z=0;z<220;z++){const g=undirected(1+rand(8)),got=undirectedConnectedComponents(g),want=connectivity(g.vertexCount,g.edges);assert.deepEqual(got.components,want);assert.equal(got.count,want.length);}
});
test('bipartite verdict equals independent brute-force two-colorability and returns valid coloring',()=>{
 for(let z=0;z<210;z++){const g=undirected(1+rand(8)),result=bipartiteGraphColoring(g);let exists=false;
  for(let m=0;m<1<<g.vertexCount;m++)if(g.edges.every(({from,to})=>Boolean(m&(1<<from))!==Boolean(m&(1<<to)))){exists=true;break;}
  assert.equal(result.bipartite,exists);
  if(exists)assert(g.edges.every(({from,to})=>result.colors[from]!==result.colors[to]));
 }
});
test('spanning tree count equals independent edge-subset enumeration and connectivity',()=>{
 for(let z=0;z<190;z++){const g=undirected(1+rand(6)),n=g.vertexCount,m=g.edges.length;let expected=0;
  for(let mask=0;mask<1<<m;mask++){
   const selected=g.edges.filter((_,j)=>mask&(1<<j));if(selected.length!==n-1)continue;
   if(connectivity(n,selected).length===1)expected++;
  }
  assert.equal(exactSpanningTreeCount(g).spanningTrees,String(expected));
 }
});
test('topological order count equals independent full-permutation oracle on random directed graphs',()=>{
 for(let z=0;z<180;z++){const g=directed(1+rand(6)),orders=permutations(Array.from({length:g.vertexCount},(_,i)=>i));
  const expected=orders.filter(order=>g.edges.every(({from,to})=>order.indexOf(from)<order.indexOf(to))).length;
  const got=exactTopologicalOrderCount(g);assert.equal(got.topologicalOrders,String(expected));assert.equal(got.acyclic,expected>0);
 }
});
test('maximum clique finds independent exhaustive subset optimum and valid witness',()=>{
 for(let z=0;z<190;z++){const g=undirected(1+rand(9)),keys=new Set(g.edges.map(e=>`${e.from}:${e.to}`));let expected=0;
  for(let mask=1;mask<1<<g.vertexCount;mask++){
   const vs=Array.from({length:g.vertexCount},(_,i)=>i).filter(i=>mask&(1<<i));
   if(vs.every((v,i)=>vs.slice(i+1).every(w=>keys.has(`${v}:${w}`))))expected=Math.max(expected,vs.length);
  }
  const got=exactMaximumClique(g);assert.equal(got.size,expected);assert(got.vertices.every((v,i)=>got.vertices.slice(i+1).every(w=>keys.has(`${v}:${w}`))));
 }
});
test('minimum dominating set matches exhaustive coverage oracle and covers every vertex',()=>{
 for(let z=0;z<190;z++){const g=undirected(1+rand(9));let expected=Infinity;
  for(let mask=1;mask<1<<g.vertexCount;mask++){
   const size=Array.from({length:g.vertexCount},(_,i)=>i).filter(v=>mask&(1<<v)).length;
   const dominated=Array.from({length:g.vertexCount},(_,v)=>v).every(v=>(mask&(1<<v))||g.edges.some(e=>(e.from===v&&(mask&(1<<e.to)))||(e.to===v&&(mask&(1<<e.from)))));
   if(dominated)expected=Math.min(expected,size);
  }
  const got=exactMinimumDominatingSet(g),set=new Set(got.vertices);assert.equal(got.size,expected);
  for(let v=0;v<g.vertexCount;v++)assert(set.has(v)||g.edges.some(e=>e.from===v&&set.has(e.to)||e.to===v&&set.has(e.from)));
 }
});
test('proper coloring count matches independent color-assignment enumeration',()=>{
 for(let z=0;z<190;z++){const g=undirected(1+rand(6)),colors=1+rand(4);let expected=0;
  for(let code=0;code<colors**g.vertexCount;code++){
   const assignment=[];let value=code;for(let v=0;v<g.vertexCount;v++){assignment.push(value%colors);value=Math.floor(value/colors);}
   if(g.edges.every(({from,to})=>assignment[from]!==assignment[to]))expected++;
  }
  assert.equal(exactProperColoringCount({...g,colors}).colorings,String(expected));
 }
});
test('Hamiltonian path existence and witness agree with independent vertex permutations',()=>{
 for(let z=0;z<165;z++){const g=undirected(1+rand(7)),edges=new Set(g.edges.flatMap(e=>[`${e.from}:${e.to}`,`${e.to}:${e.from}`]));
  const expected=permutations(Array.from({length:g.vertexCount},(_,i)=>i)).some(p=>p.slice(1).every((v,i)=>edges.has(`${p[i]}:${v}`)));
  const got=exactHamiltonianPath(g);assert.equal(got.exists,expected);
  if(expected){assert.equal(new Set(got.path).size,g.vertexCount);assert(got.path.slice(1).every((v,i)=>edges.has(`${got.path[i]}:${v}`)));}
 }
});
test('simple directed path count matches independent exhaustive DFS',()=>{
 for(let z=0;z<180;z++){const g=directed(2+rand(7)),source=rand(g.vertexCount),target=(source+1+rand(g.vertexCount-1))%g.vertexCount;
  let expected=0;function dfs(v,used){if(v===target){expected++;return;}for(const e of g.edges)if(e.from===v&&!used.has(e.to))dfs(e.to,new Set([...used,e.to]));}
  dfs(source,new Set([source]));assert.equal(exactSimplePathCount({...g,source,target}).simplePaths,String(expected));
 }
});
test('directed walk count matches separate recursive walk enumeration',()=>{
 for(let z=0;z<190;z++){const g=directed(2+rand(5)),source=rand(g.vertexCount),target=rand(g.vertexCount),length=rand(7);
  const oracle=(v,remaining)=>remaining?g.edges.filter(e=>e.from===v).reduce((s,e)=>s+oracle(e.to,remaining-1),0):Number(v===target);
  assert.equal(exactWalkCount({...g,source,target,length}).walks,String(oracle(source,length)));
 }
});
test('general-graph matching agrees with exhaustive edge-subset optimum and valid endpoint disjointness',()=>{
 for(let z=0;z<170;z++){const g=undirected(1+rand(8));let expected=0;
  for(let mask=0;mask<1<<g.edges.length;mask++){
   const chosen=g.edges.filter((_,j)=>mask&(1<<j)),used=chosen.flatMap(e=>[e.from,e.to]);
   if(new Set(used).size===used.length)expected=Math.max(expected,chosen.length);
  }
  const got=exactGeneralMaximumMatching(g),ends=got.edges.flat();assert.equal(got.cardinality,expected);assert.equal(new Set(ends).size,ends.length);
 }
});
test('girth agrees with exhaustive cycles on bounded undirected graphs',()=>{
 for(let z=0;z<180;z++){const g=undirected(1+rand(7));let shortest=Infinity,edges=new Set(g.edges.flatMap(e=>[`${e.from}:${e.to}`,`${e.to}:${e.from}`]));
  const vs=Array.from({length:g.vertexCount},(_,v)=>v);for(const path of permutations(vs)){
   for(let len=3;len<=path.length;len++)if(path[0]===Math.min(...path.slice(0,len))&&path.slice(1,len).every((v,i)=>edges.has(`${path[i]}:${v}`))&&edges.has(`${path[len-1]}:${path[0]}`))shortest=Math.min(shortest,len);
  }
  const got=exactGraphGirth(g);assert.equal(got.girth,Number.isFinite(shortest)?shortest:null);assert.equal(got.acyclic,!Number.isFinite(shortest));
 }
});
test('all graph combinatorics fail closed on invalid and unsupported inputs',()=>{
 assert.throws(()=>undirectedConnectedComponents({vertexCount:0,edges:[]}),/integer/);
 assert.throws(()=>bipartiteGraphColoring({vertexCount:2,edges:[{from:0,to:0}]}),/self loops/);
 assert.throws(()=>exactSpanningTreeCount({vertexCount:13,edges:[]}),/integer/);
 assert.throws(()=>exactTopologicalOrderCount({vertexCount:17,edges:[]}),/integer/);
 assert.throws(()=>exactMaximumClique({vertexCount:2,edges:[{from:0,to:1},{from:1,to:0}]}),/duplicate/);
 assert.throws(()=>exactMinimumDominatingSet({vertexCount:17,edges:[]}),/integer/);
 assert.throws(()=>exactProperColoringCount({vertexCount:12,edges:[],colors:8}),/budget/);
 assert.throws(()=>exactHamiltonianPath({vertexCount:16,edges:[]}),/integer/);
 assert.throws(()=>exactSimplePathCount({vertexCount:2,edges:[],source:0,target:0}),/differ/);
 assert.throws(()=>exactWalkCount({vertexCount:2,edges:[],source:0,target:1,length:61}),/integer/);
 assert.throws(()=>exactGeneralMaximumMatching({vertexCount:17,edges:[]}),/integer/);
 assert.throws(()=>exactGraphGirth({vertexCount:2,edges:[{from:0,to:1,weight:1}]}),/shape/);
});
