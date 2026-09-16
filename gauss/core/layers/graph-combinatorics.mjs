// Exact bounded finite graph computations. Exponential algorithms reject oversized inputs.
const int = (v, label, min, max) => {if(!Number.isSafeInteger(v)||v<min||v>max)throw new TypeError(`${label} must be integer in [${min},${max}]`);return v;};
const freeze = x => Object.freeze(x);
function graph(input,{directed=false,maxVertices=16,maxEdges=80}={}){
 const n=int(input.vertexCount,'vertexCount',1,maxVertices),es=input.edges;
 if(!Array.isArray(es)||es.length>maxEdges)throw new TypeError('edges length exceeds bounded budget');
 const pairs=[],seen=new Set();for(const [i,e] of es.entries()){
  if(!e||typeof e!=='object'||Array.isArray(e)||Object.keys(e).sort().join(',')!=='from,to')throw new TypeError(`edges[${i}] shape invalid`);
  const a=int(e.from,`edges[${i}].from`,0,n-1),b=int(e.to,`edges[${i}].to`,0,n-1);
  if(a===b)throw new TypeError('self loops are not supported');
  const key=directed?`${a},${b}`:`${Math.min(a,b)},${Math.max(a,b)}`;
  if(seen.has(key))throw new TypeError('duplicate graph edge');seen.add(key);pairs.push([a,b]);
 }
 return {n,pairs};
}
const adjacency = ({n,pairs},directed=false)=>{const a=Array.from({length:n},()=>[]);for(const [x,y] of pairs){a[x].push(y);if(!directed)a[y].push(x);}for(const row of a)row.sort((a,b)=>a-b);return a;};
const bit = i=>1<<i;
const has = (mask,i)=>Boolean(mask&bit(i));
const popcount = mask=>{let count=0;while(mask){mask&=mask-1;count++;}return count;};
function detBareiss(mat){const n=mat.length;if(n===0)return 1n;
 const a=mat.map(row=>row.map(BigInt));let sign=1n,prev=1n;
 for(let k=0;k<n-1;k++){
  let pivot=k;while(pivot<n&&a[pivot][k]===0n)pivot++;if(pivot===n)return 0n;
  if(pivot!==k){[a[k],a[pivot]]=[a[pivot],a[k]];sign=-sign;}
  const value=a[k][k];for(let i=k+1;i<n;i++)for(let j=k+1;j<n;j++){
   const numerator=a[i][j]*value-a[i][k]*a[k][j];
   if(numerator%prev!==0n)throw new RangeError('Bareiss nonintegral division');
   a[i][j]=numerator/prev;
  }
  for(let i=k+1;i<n;i++)a[i][k]=0n;prev=value;
 }
 return sign*a[n-1][n-1];
}
export function undirectedConnectedComponents(input){const g=graph(input),adj=adjacency(g),seen=new Set(),groups=[];
 for(let v=0;v<g.n;v++){if(seen.has(v))continue;const q=[v],group=[];seen.add(v);
  for(let i=0;i<q.length;i++){const u=q[i];group.push(u);for(const w of adj[u])if(!seen.has(w)){seen.add(w);q.push(w);}}
  groups.push(freeze(group.sort((a,b)=>a-b)));
 }return freeze({components:freeze(groups),count:groups.length});
}
export function bipartiteGraphColoring(input){const g=graph(input),adj=adjacency(g),colors=Array(g.n).fill(-1);
 for(let v=0;v<g.n;v++){if(colors[v]!==-1)continue;colors[v]=0;const q=[v];
  for(let i=0;i<q.length;i++)for(const w of adj[q[i]]){
   if(colors[w]===-1){colors[w]=1-colors[q[i]];q.push(w);}
   else if(colors[w]===colors[q[i]])return freeze({bipartite:false,colors:null});
  }
 }return freeze({bipartite:true,colors:freeze(colors)});
}
export function exactSpanningTreeCount(input){const g=graph(input,{maxVertices:12,maxEdges:66}),lap=Array.from({length:g.n},()=>Array(g.n).fill(0));
 for(const [u,v] of g.pairs){lap[u][u]++;lap[v][v]++;lap[u][v]--;lap[v][u]--;}
 const trees=detBareiss(lap.slice(1).map(row=>row.slice(1)));
 return freeze({spanningTrees:trees.toString()});
}
export function exactTopologicalOrderCount(input){const g=graph(input,{directed:true,maxVertices:16,maxEdges:80}),pre=Array(g.n).fill(0);
 for(const [u,v] of g.pairs)pre[v]|=bit(u);
 const count=Array(1<<g.n).fill(0n);count[0]=1n;
 for(let mask=0;mask<count.length;mask++)if(count[mask])for(let v=0;v<g.n;v++){
  if(!has(mask,v)&&(pre[v]&mask)===pre[v])count[mask|bit(v)]+=count[mask];
 }
 return freeze({topologicalOrders:count.at(-1).toString(),acyclic:count.at(-1)>0n});
}
export function exactMaximumClique(input){const g=graph(input,{maxVertices:16,maxEdges:80}),adj=Array(g.n).fill(0);
 for(const [u,v] of g.pairs){adj[u]|=bit(v);adj[v]|=bit(u);}
 let bestMask=1,best=1;
 for(let mask=1;mask<(1<<g.n);mask++){
  const size=popcount(mask);if(size<=best)continue;
  let valid=true;for(let v=0;v<g.n;v++)if(has(mask,v)&&((mask^bit(v))&adj[v])!==(mask^bit(v))){valid=false;break;}
  if(valid){best=size;bestMask=mask;}
 }
 return freeze({size:best,vertices:freeze(Array.from({length:g.n},(_,v)=>v).filter(v=>has(bestMask,v)))});
}
export function exactMinimumDominatingSet(input){const g=graph(input,{maxVertices:16,maxEdges:80}),adj=Array.from({length:g.n},(_,v)=>bit(v));
 for(const [u,v] of g.pairs){adj[u]|=bit(v);adj[v]|=bit(u);}
 let best=g.n+1,bestMask=0;const full=(1<<g.n)-1;
 for(let mask=1;mask<=full;mask++){
  const size=popcount(mask);if(size>=best)continue;
  let dominated=0;for(let v=0;v<g.n;v++)if(has(mask,v))dominated|=adj[v];
  if(dominated===full){best=size;bestMask=mask;}
 }
 return freeze({size:best,vertices:freeze(Array.from({length:g.n},(_,v)=>v).filter(v=>has(bestMask,v)))});
}
export function exactProperColoringCount({...input}){const g=graph(input,{maxVertices:12,maxEdges:66}),k=int(input.colors,'colors',1,8),adj=adjacency(g),assign=Array(g.n).fill(-1);
 let count=0n;function visit(v){if(v===g.n){count++;return;}
  for(let c=0;c<k;c++){if(adj[v].some(w=>w<v&&assign[w]===c))continue;assign[v]=c;visit(v+1);}
  assign[v]=-1;
 }
 // Complexity bound: 8^12 is prohibited even if the graph is sparse.
 if(BigInt(k)**BigInt(g.n)>10_000_000n)throw new RangeError('proper coloring enumeration exceeds bounded budget');
 visit(0);return freeze({colorings:count.toString()});
}
export function exactHamiltonianPath(input){const g=graph(input,{maxVertices:15,maxEdges:70}),adj=adjacency(g);
 const states=Array.from({length:1<<g.n},()=>Array(g.n).fill(false)),parents=Array.from({length:1<<g.n},()=>Array(g.n).fill(-1));
 for(let v=0;v<g.n;v++)states[bit(v)][v]=true;
 for(let mask=1;mask<states.length;mask++)for(let v=0;v<g.n;v++)if(states[mask][v])for(const w of adj[v])if(!has(mask,w)&&!states[mask|bit(w)][w]){
  states[mask|bit(w)][w]=true;parents[mask|bit(w)][w]=v;
 }
 let end=states.at(-1).findIndex(Boolean);if(end<0)return freeze({exists:false,path:null});
 const path=[];let mask=states.length-1;while(end!==-1){path.push(end);const prior=parents[mask][end];mask^=bit(end);end=prior;}
 return freeze({exists:true,path:freeze(path.reverse())});
}
export function exactSimplePathCount(input){const g=graph(input,{directed:true,maxVertices:14,maxEdges:70}),source=int(input.source,'source',0,g.n-1),target=int(input.target,'target',0,g.n-1);
 if(source===target)throw new TypeError('source and target must differ');
 const adj=adjacency(g,true),memo=new Map();function count(v,mask){if(v===target)return 1n;
  const key=`${v}/${mask}`;if(memo.has(key))return memo.get(key);let total=0n;
  for(const w of adj[v])if(!has(mask,w))total+=count(w,mask|bit(w));
  memo.set(key,total);return total;
 }
 return freeze({simplePaths:count(source,bit(source)).toString()});
}
export function exactWalkCount(input){const g=graph(input,{directed:true,maxVertices:12,maxEdges:70}),source=int(input.source,'source',0,g.n-1),target=int(input.target,'target',0,g.n-1),length=int(input.length,'length',0,60);
 const adj=adjacency(g,true);let counts=Array(g.n).fill(0n);counts[source]=1n;
 for(let step=0;step<length;step++){const next=Array(g.n).fill(0n);for(let v=0;v<g.n;v++)for(const w of adj[v])next[w]+=counts[v];counts=next;}
 return freeze({walks:counts[target].toString(),length});
}
export function exactGeneralMaximumMatching(input){const g=graph(input,{maxVertices:16,maxEdges:80}),adj=Array(g.n).fill(0);
 for(const [u,v] of g.pairs){adj[u]|=bit(v);adj[v]|=bit(u);}
 const memo=new Map();function solve(mask){if(!mask)return {size:0,edges:[]};if(memo.has(mask))return memo.get(mask);
  let v=0;while(!has(mask,v))v++;let best=solve(mask^bit(v));
  for(let w=v+1;w<g.n;w++)if(has(mask,w)&&has(adj[v],w)){
   const sub=solve(mask^bit(v)^bit(w)),candidate={size:sub.size+1,edges:[[v,w],...sub.edges]};
   if(candidate.size>best.size)best=candidate;
  }
  memo.set(mask,best);return best;
 }
 const result=solve((1<<g.n)-1);return freeze({cardinality:result.size,edges:freeze(result.edges.map(e=>freeze(e)))});
}
export function exactGraphGirth(input){const g=graph(input,{maxVertices:16,maxEdges:80}),adj=adjacency(g);let shortest=Infinity;
 for(let root=0;root<g.n;root++){
  const distance=Array(g.n).fill(-1),parent=Array(g.n).fill(-1),queue=[root];distance[root]=0;
  for(let i=0;i<queue.length;i++){const v=queue[i];for(const w of adj[v]){
   if(distance[w]<0){distance[w]=distance[v]+1;parent[w]=v;queue.push(w);}
   else if(parent[v]!==w)shortest=Math.min(shortest,distance[v]+distance[w]+1);
  }}
 }
 return freeze({girth:Number.isFinite(shortest)?shortest:null,acyclic:!Number.isFinite(shortest)});
}
