import test from 'node:test';
import assert from 'node:assert/strict';
import {
 bellmanFordSigned, floydWarshallAllPairs, articulationVertices, graphBridges,
 exactWeightedVertexCover, exactGraphColoring, minimumCostAssignment,
 weightedTreeDiameter, directedEulerTrail,
} from '../core/layers/graph-advanced.mjs';
let state=0x728fa21;
function rnd(){state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/2**32;}
const randint=n=>Math.floor(rnd()*n);
function pairs(n,p=.4){const result=[];for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(rnd()<p)result.push({from:i,to:j});return result;}
function reachCount(n,edges,removedVertex=-1,removedEdge=-1){
 const seen=new Set();let components=0;
 for(let i=0;i<n;i++)if(i!==removedVertex&&!seen.has(i)){
  components++;let stack=[i];seen.add(i);
  while(stack.length){const u=stack.pop();for(let k=0;k<edges.length;k++){
   if(k===removedEdge)continue;const e=edges[k];if(e.from===removedVertex||e.to===removedVertex)continue;
   const v=e.from===u?e.to:e.to===u?e.from:-1;
   if(v>=0&&!seen.has(v)){seen.add(v);stack.push(v);}
  }}
 }
 return components;
}
test('Bellman-Ford signed path agrees with independent exhaustive simple-path oracle on 240 acyclic graphs',()=>{
 for(let run=0;run<240;run++){
  const n=2+randint(7), edges=[];
  for(let u=0;u<n;u++)for(let v=u+1;v<n;v++)if(rnd()<.55)edges.push({from:u,to:v,cost:randint(21)-10});
  const target=n-1;
  let best=Infinity;
  function dfs(u,d){if(u===target){best=Math.min(best,d);return;}for(const e of edges)if(e.from===u)dfs(e.to,d+e.cost);}
  dfs(0,0);
  const out=bellmanFordSigned({vertexCount:n,edges,source:0,target});
  assert.equal(out.reachable,best!==Infinity);
  assert.equal(out.distance,best===Infinity?null:best);
  if(out.reachable){let sum=0;for(let j=0;j<out.path.length-1;j++){
   const edge=edges.find(e=>e.from===out.path[j]&&e.to===out.path[j+1]);assert(edge);sum+=edge.cost;
  }assert.equal(sum,best);assert.equal(out.path[0],0);assert.equal(out.path.at(-1),target);}
 }
 assert.throws(()=>bellmanFordSigned({vertexCount:3,edges:[{from:0,to:1,cost:-2},{from:1,to:0,cost:1}],source:0,target:2}),/negative-weight cycle/);
 assert.equal(bellmanFordSigned({vertexCount:4,edges:[{from:2,to:3,cost:-2},{from:3,to:2,cost:1}],source:0,target:1}).reachable,false);
});
test('Floyd-Warshall equals separately enumerated all-pairs paths on 180 signed DAGs',()=>{
 for(let run=0;run<180;run++){
  const n=2+randint(7),edges=[];
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(rnd()<.7)edges.push({from:i,to:j,cost:randint(15)-5});
  const got=floydWarshallAllPairs({vertexCount:n,edges}).distances;
  for(let s=0;s<n;s++)for(let t=0;t<n;t++){
   let optimal=s===t?0:Infinity;
   function dfs(u,dist){if(u===t){optimal=Math.min(optimal,dist);return;}
    for(const edge of edges)if(edge.from===u)dfs(edge.to,dist+edge.cost);}
   dfs(s,0);assert.equal(got[s][t],optimal===Infinity?null:optimal);
  }
 }
 assert.throws(()=>floydWarshallAllPairs({vertexCount:2,edges:[{from:0,to:1,cost:-2},{from:1,to:0,cost:1}]}),/negative-weight cycle/);
});
test('articulation and bridge low-link witnesses match independent vertex/edge removal on 280 graphs',()=>{
 for(let run=0;run<280;run++){
  const n=2+randint(8),edges=pairs(n,.42),before=reachCount(n,edges);
  const cuts=articulationVertices({vertexCount:n,edges});const bridges=graphBridges({vertexCount:n,edges});
  const expectedCuts=Array.from({length:n},(_,i)=>i).filter(i=>reachCount(n,edges,i)>before);
  const expectedBridges=edges.filter((e,i)=>reachCount(n,edges,-1,i)>before)
   .map(e=>({from:e.from,to:e.to})).sort((a,b)=>a.from-b.from||a.to-b.to);
  assert.deepEqual(cuts.vertices,expectedCuts);assert.deepEqual(bridges.bridges,expectedBridges);
 }
});
test('minimum weighted vertex cover matches independent full subset oracle on 180 graphs',()=>{
 for(let run=0;run<180;run++){
  const n=1+randint(9),edges=pairs(n,.4),weights=Array.from({length:n},()=>randint(9));
  let best=Infinity;
  for(let mask=0;mask<(1<<n);mask++) if(edges.every(e=>(mask&(1<<e.from))||(mask&(1<<e.to)))) {
   let value=0;for(let v=0;v<n;v++)if(mask&(1<<v))value+=weights[v];best=Math.min(best,value);
  }
  const out=exactWeightedVertexCover({vertexCount:n,edges,weights});assert.equal(out.minimumWeight,best);
  assert(edges.every(e=>out.vertices.includes(e.from)||out.vertices.includes(e.to)));
  assert.equal(out.vertices.reduce((sum,v)=>sum+weights[v],0),best);
 }
});
test('exact coloring agrees with a different brute-force k-colorability oracle on 100 small graphs',()=>{
 for(let run=0;run<100;run++){
  const n=1+randint(6),edges=pairs(n,.5),got=exactGraphColoring({vertexCount:n,edges});
  function isKColorable(k){const colors=Array(n).fill(-1);function dfs(i){if(i===n)return true;
   for(let c=0;c<k;c++){if(edges.some(e=>(e.from===i&&colors[e.to]===c)||(e.to===i&&colors[e.from]===c)))continue;
    colors[i]=c;if(dfs(i+1))return true;colors[i]=-1; }return false;}return dfs(0);}
  let best=1;while(!isKColorable(best))best++;
  assert.equal(got.chromaticNumber,best);
  assert(edges.every(e=>got.colors[e.from]!==got.colors[e.to]));
  assert.equal(new Set(got.colors).size,best);
 }
});
test('minimum-cost assignment equals independent permutation oracle on 130 signed matrices',()=>{
 for(let run=0;run<130;run++){
  const n=1+randint(7),costs=Array.from({length:n},()=>Array.from({length:n},()=>randint(21)-10));
  let optimum=Infinity;
  function search(i,mask,total){if(i===n){optimum=Math.min(optimum,total);return;}
   for(let j=0;j<n;j++)if(!(mask&(1<<j)))search(i+1,mask|(1<<j),total+costs[i][j]);}
  search(0,0,0);
  const got=minimumCostAssignment({costs});assert.equal(got.minimumCost,optimum);
  assert.equal(new Set(got.assignedColumns).size,n);
  assert.equal(got.assignedColumns.reduce((sum,col,row)=>sum+costs[row][col],0),optimum);
 }
});
test('weighted diameter matches all-pairs traversal oracle on 180 random trees',()=>{
 for(let run=0;run<180;run++){
  const n=1+randint(20),edges=[];
  for(let i=1;i<n;i++)edges.push({from:i,to:randint(i),weight:randint(12)});
  const got=weightedTreeDiameter({vertexCount:n,edges});
  let optimal=0;
  for(let s=0;s<n;s++){
   const stack=[[s,-1,0]];while(stack.length){const [u,p,d]=stack.pop();optimal=Math.max(optimal,d);
    for(const e of edges){const v=e.from===u?e.to:e.to===u?e.from:-1;if(v>=0&&v!==p)stack.push([v,u,d+e.weight]);}
   }
  }
  assert.equal(got.diameter,optimal);
  let routeCost=0;for(let k=1;k<got.path.length;k++){
   const edge=edges.find(e=>(e.from===got.path[k-1]&&e.to===got.path[k])||(e.to===got.path[k-1]&&e.from===got.path[k]));
   assert(edge);routeCost+=edge.weight;
  }assert.equal(routeCost,optimal);
 }
 assert.throws(()=>weightedTreeDiameter({vertexCount:3,edges:[{from:0,to:1,weight:1}]}),/exactly/);
});
test('directed Euler trail consumes each actual edge once for 200 generated Eulerian walks',()=>{
 for(let run=0;run<200;run++){
  const n=2+randint(8),m=1+randint(25),vertices=[randint(n)];
  for(let k=0;k<m;k++){let next=randint(n-1);if(next>=vertices.at(-1))next++;vertices.push(next);}
  const edges=Array.from({length:m},(_,k)=>({from:vertices[k],to:vertices[k+1]}));
  const got=directedEulerTrail({vertexCount:n,edges});
  assert.equal(got.path.length,m+1);assert.equal(got.edgeIds.length,m);
  assert.equal(new Set(got.edgeIds).size,m);
  for(let k=0;k<m;k++){
   const e=edges[got.edgeIds[k]];assert.equal(e.from,got.path[k]);assert.equal(e.to,got.path[k+1]);
  }
 }
 assert.throws(()=>directedEulerTrail({vertexCount:4,edges:[{from:0,to:1},{from:2,to:3}]}),/degree mismatch|one Euler trail/);
});
test('all advanced operators fail closed on malformed or oversized data',()=>{
 assert.throws(()=>bellmanFordSigned({vertexCount:2,edges:[{from:0,to:1,cost:NaN}],source:0,target:1}),/integer/);
 assert.throws(()=>floydWarshallAllPairs({vertexCount:49,edges:[]}),/vertexCount/);
 assert.throws(()=>articulationVertices({vertexCount:3,edges:[{from:0,to:1},{from:1,to:0}]}),/duplicate/);
 assert.throws(()=>graphBridges({vertexCount:3,edges:[{from:0,to:0}]}),/self/);
 assert.throws(()=>exactWeightedVertexCover({vertexCount:19,edges:[],weights:Array(19).fill(1)}),/vertexCount/);
 assert.throws(()=>exactGraphColoring({vertexCount:11,edges:[]}),/vertexCount/);
 assert.throws(()=>minimumCostAssignment({costs:[[0,1]]}),/square/);
 assert.throws(()=>weightedTreeDiameter({vertexCount:2,edges:[{from:0,to:1,weight:-1}]}),/integer/);
 assert.throws(()=>directedEulerTrail({vertexCount:3,edges:[{from:0,to:1},{from:0,to:2}]}),/degree mismatch/);
});
