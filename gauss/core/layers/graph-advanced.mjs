// Distinct bounded graph and discrete optimization algorithms. Integer weights are
// restricted so that sums and all returned exact optima remain safe JS integers.
const freeze = Object.freeze;
function whole(v, label, min, max) {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new TypeError(`${label} must be an integer in [${min},${max}]`);
  return v;
}
function graph({ vertexCount, edges }, maxVertices = 48, maxEdges = 1024) {
  const n = whole(vertexCount, 'vertexCount', 1, maxVertices);
  if (!Array.isArray(edges) || edges.length > maxEdges) throw new TypeError('edges must be a bounded array');
  const parsed = edges.map((e, i) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new TypeError('edge must be an object');
    const from = whole(e.from, `edges[${i}].from`, 0, n-1), to = whole(e.to, `edges[${i}].to`, 0, n-1);
    if (from === to) throw new TypeError('self edges are unsupported');
    return { from, to, edge: e, id: i };
  });
  return { n, edges: parsed };
}
function cost(e, field, index, low = -1000000) { return whole(e[field], `edges[${index}].${field}`, low, 1000000); }

// Handles negative weights; negative-cycle detection is restricted to vertices
// reachable from the requested source, unlike a global graph feasibility test.
export function bellmanFordSigned({ vertexCount, edges, source, target }) {
  const g = graph({vertexCount, edges});
  const s=whole(source,'source',0,g.n-1), t=whole(target,'target',0,g.n-1);
  const es=g.edges.map(e=>({from:e.from,to:e.to,cost:cost(e.edge,'cost',e.id)}));
  const d=Array(g.n).fill(Infinity), pred=Array(g.n).fill(-1); d[s]=0;
  for(let k=1;k<g.n;k++) {
    let changed=false;
    for(const e of es) if(d[e.from]!==Infinity && d[e.from]+e.cost<d[e.to]) {
      d[e.to]=d[e.from]+e.cost; pred[e.to]=e.from; changed=true;
    }
    if(!changed) break;
  }
  for(const e of es) if(d[e.from]!==Infinity && d[e.from]+e.cost<d[e.to])
    throw new RangeError('reachable negative-weight cycle: shortest path undefined');
  if(d[t]===Infinity) return freeze({reachable:false,distance:null,path:freeze([])});
  const path=[],seen=new Set();
  for(let at=t;at!==-1;at=pred[at]) {
    if(seen.has(at)) throw new Error('predecessor cycle');
    seen.add(at); path.push(at);
  }
  path.reverse();
  if(path[0]!==s) throw new Error('shortest-path witness does not start at source');
  return freeze({reachable:true,distance:d[t],path:freeze(path)});
}

// Floyd-Warshall reports unreachable pairs as null, never serialized Infinity.
export function floydWarshallAllPairs({vertexCount,edges}) {
  const g=graph({vertexCount,edges},48,1024);
  const d=Array.from({length:g.n},(_,i)=>Array.from({length:g.n},(_,j)=>i===j?0:Infinity));
  for(const e of g.edges) d[e.from][e.to]=Math.min(d[e.from][e.to],cost(e.edge,'cost',e.id));
  for(let k=0;k<g.n;k++) for(let i=0;i<g.n;i++) if(d[i][k]!==Infinity)
    for(let j=0;j<g.n;j++) if(d[k][j]!==Infinity)
      d[i][j]=Math.min(d[i][j],d[i][k]+d[k][j]);
  if(d.some((row,i)=>row[i]<0)) throw new RangeError('negative-weight cycle: all-pairs shortest paths undefined');
  return freeze({distances:freeze(d.map(row=>freeze(row.map(v=>v===Infinity?null:v))))});
}

function undirected({vertexCount,edges},max=128) {
  const g=graph({vertexCount,edges},max,1024);
  const adj=Array.from({length:g.n},()=>[]);
  const keys=new Set();
  for(const e of g.edges) {
    const a=Math.min(e.from,e.to),b=Math.max(e.from,e.to),key=`${a}:${b}`;
    if(keys.has(key)) throw new TypeError('duplicate undirected edge');
    keys.add(key);
    adj[e.from].push({to:e.to,id:e.id});adj[e.to].push({to:e.from,id:e.id});
  }
  return {...g,adj};
}
function lowLink(g) {
  const tin=Array(g.n).fill(-1),low=Array(g.n).fill(-1),cuts=new Set(),bridges=[];
  let tick=0;
  function visit(u,parentEdge=-1) {
    tin[u]=low[u]=tick++;let children=0;
    for(const e of g.adj[u]) {
      if(e.id===parentEdge) continue;
      if(tin[e.to]!==-1) low[u]=Math.min(low[u],tin[e.to]);
      else {
        children++;visit(e.to,e.id);low[u]=Math.min(low[u],low[e.to]);
        if(parentEdge!==-1 && low[e.to]>=tin[u])cuts.add(u);
        if(low[e.to]>tin[u])bridges.push({from:Math.min(u,e.to),to:Math.max(u,e.to)});
      }
    }
    if(parentEdge===-1 && children>1)cuts.add(u);
  }
  for(let i=0;i<g.n;i++)if(tin[i]===-1)visit(i);
  bridges.sort((a,b)=>a.from-b.from||a.to-b.to);
  return {cuts:[...cuts].sort((a,b)=>a-b),bridges};
}
export function articulationVertices(input) {
  const {cuts}=lowLink(undirected(input));
  return freeze({vertices:freeze(cuts),count:cuts.length});
}
export function graphBridges(input) {
  const {bridges}=lowLink(undirected(input));
  return freeze({bridges:freeze(bridges.map(freeze)),count:bridges.length});
}

// Exact minimum-weight vertex cover: deliberately limited to 18 vertices;
// choose the first uncovered edge and branch on its two endpoints.
export function exactWeightedVertexCover({vertexCount,edges,weights}) {
  const g=undirected({vertexCount,edges},18);
  if(!Array.isArray(weights)||weights.length!==g.n)throw new TypeError('weights length mismatch');
  const w=weights.map((v,i)=>whole(v,`weights[${i}]`,0,1000000));
  let best=Infinity,bestMask=0,visited=0;
  const es=g.edges.map(e=>[e.from,e.to]);
  function visit(mask,total) {
    if(++visited>2000000)throw new RangeError('exact vertex cover search budget exhausted');
    if(total>best)return;
    const missing=es.find(([a,b])=>!(mask&(1<<a))&&!(mask&(1<<b)));
    if(!missing) {
      if(total<best || (total===best && mask<bestMask)){best=total;bestMask=mask;}
      return;
    }
    for(const v of missing)visit(mask|(1<<v),total+w[v]);
  }
  visit(0,0);
  return freeze({minimumWeight:best,vertices:freeze(Array.from({length:g.n},(_,i)=>i).filter(i=>bestMask&(1<<i))),visitedNodes:visited});
}

// Small exact chromatic number with a reproducible canonical first optimum.
export function exactGraphColoring({vertexCount,edges}) {
  const g=undirected({vertexCount,edges},10);
  const adjacent=Array.from({length:g.n},()=>new Set());
  for(const e of g.edges){adjacent[e.from].add(e.to);adjacent[e.to].add(e.from);}
  const order=Array.from({length:g.n},(_,i)=>i).sort((a,b)=>adjacent[b].size-adjacent[a].size||a-b);
  const color=Array(g.n).fill(-1),optimal=Array(g.n).fill(-1);
  let best=g.n+1,visited=0;
  function visit(position,used) {
    if(++visited>2000000)throw new RangeError('exact coloring search budget exhausted');
    if(used>=best)return;
    if(position===g.n){best=used;for(let i=0;i<g.n;i++)optimal[i]=color[i];return;}
    const u=order[position];
    const forbidden=new Set([...adjacent[u]].map(v=>color[v]).filter(v=>v>=0));
    for(let c=0;c<=used;c++) {
      if(c>=best||forbidden.has(c))continue;
      color[u]=c;visit(position+1,Math.max(used,c+1));color[u]=-1;
    }
  }
  visit(0,0);
  return freeze({chromaticNumber:best,colors:freeze(optimal),visitedNodes:visited});
}

// Exact minimum-cost square assignment, distinct from maximum-cardinality matching.
export function minimumCostAssignment({costs}) {
  if(!Array.isArray(costs)||costs.length<1||costs.length>12||costs.some(r=>!Array.isArray(r)||r.length!==costs.length))
    throw new TypeError('costs must be a square matrix of size 1..12');
  const n=costs.length,a=costs.map((r,i)=>r.map((v,j)=>whole(v,`costs[${i}][${j}]`,-1000000,1000000)));
  const count=1<<n,dp=Array(count).fill(Infinity),choice=Array(count).fill(-1);dp[0]=0;
  for(let mask=1;mask<count;mask++){
    let row=0;for(let bits=mask;bits;bits&=bits-1)row++;
    row--;
    for(let col=0;col<n;col++)if(mask&(1<<col)){
      const previous=mask^(1<<col),candidate=dp[previous]+a[row][col];
      if(candidate<dp[mask]||(candidate===dp[mask]&&col<choice[mask])){
        dp[mask]=candidate;choice[mask]=col;
      }
    }
  }
  let mask=count-1;const assigned=Array(n);
  for(let row=n-1;row>=0;row--){assigned[row]=choice[mask];mask^=1<<assigned[row];}
  return freeze({minimumCost:dp[count-1],assignedColumns:freeze(assigned)});
}

// Check that input is a tree, then obtain a weighted diameter via two traversals.
export function weightedTreeDiameter({vertexCount,edges}) {
  const g=undirected({vertexCount,edges});
  if(g.edges.length!==g.n-1)throw new TypeError('tree requires exactly vertexCount-1 edges');
  const adj=Array.from({length:g.n},()=>[]);
  for(const e of g.edges){const w=cost(e.edge,'weight',e.id,0);adj[e.from].push([e.to,w]);adj[e.to].push([e.from,w]);}
  function farthest(source){
    const dist=Array(g.n).fill(null),parent=Array(g.n).fill(-1);dist[source]=0;
    const queue=[source];
    for(let qi=0;qi<queue.length;qi++){
      const u=queue[qi];for(const [v,w] of adj[u])if(dist[v]===null){
        dist[v]=dist[u]+w;parent[v]=u;queue.push(v);
      }
    }
    if(queue.length!==g.n)throw new TypeError('tree must be connected');
    let end=0;for(let i=1;i<g.n;i++)if(dist[i]>dist[end])end=i;
    return {end,dist,parent};
  }
  const endpoint=farthest(0).end,second=farthest(endpoint),path=[];
  for(let u=second.end;u!==-1;u=second.parent[u])path.push(u);
  path.reverse();
  return freeze({diameter:second.dist[second.end],endpoints:freeze([endpoint,second.end]),path:freeze(path)});
}

// Hierholzer over directed edges with edge identities; returns each edge once.
export function directedEulerTrail({vertexCount,edges}) {
  const g=graph({vertexCount,edges},128,1024),out=Array(g.n).fill(0),inDegree=Array(g.n).fill(0);
  const adj=Array.from({length:g.n},()=>[]);
  for(const e of g.edges){out[e.from]++;inDegree[e.to]++;adj[e.from].push(e);}
  let start=-1,end=-1;
  for(let i=0;i<g.n;i++){
    const difference=out[i]-inDegree[i];
    if(difference===1){if(start!==-1)throw new RangeError('directed Euler trail degree mismatch');start=i;}
    else if(difference===-1){if(end!==-1)throw new RangeError('directed Euler trail degree mismatch');end=i;}
    else if(difference!==0)throw new RangeError('directed Euler trail degree mismatch');
  }
  if((start===-1)!==(end===-1))throw new RangeError('directed Euler trail degree mismatch');
  if(start===-1)start=out.findIndex(v=>v>0);
  if(start===-1)return freeze({path:freeze([0]),edgeIds:freeze([]),closed:true});
  for(const row of adj)row.reverse();
  const vertices=[start],incoming=[-1],path=[],ids=[];
  while(vertices.length){
    const u=vertices[vertices.length-1];
    if(adj[u].length){const e=adj[u].pop();vertices.push(e.to);incoming.push(e.id);}
    else{path.push(vertices.pop());const id=incoming.pop();if(id!==-1)ids.push(id);}
  }
  if(ids.length!==g.edges.length)throw new RangeError('directed edges are not in one Euler trail');
  path.reverse();ids.reverse();
  return freeze({path:freeze(path),edgeIds:freeze(ids),closed:path[0]===path[path.length-1]});
}
