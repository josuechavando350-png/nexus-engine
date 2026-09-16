// Bounded graph structural algorithms. Directed/undirected semantics are explicit.
const fail=m=>{throw new TypeError(m);};
const integer=(v,label,min,max)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail(`${label} must be safe integer in [${min},${max}]`);return v;};
const shape=(x,keys)=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).sort().join('|')!==keys.slice().sort().join('|'))fail(`expected exactly ${keys.join(',')}`);};
const freeze=Object.freeze;
function graph(input, keys=['vertexCount','edges'],directed=true,maxN=12,maxE=60){shape(input,keys);const n=integer(input.vertexCount,'vertexCount',1,maxN);
 if(!Array.isArray(input.edges)||input.edges.length>maxE)fail('edges size invalid');const edges=[],seen=new Set();
 for(const [i,e] of input.edges.entries()){shape(e,['from','to']);const u=integer(e.from,`edges[${i}].from`,0,n-1),v=integer(e.to,`edges[${i}].to`,0,n-1);if(u===v)fail('self-loop not supported');const key=directed?`${u},${v}`:`${Math.min(u,v)},${Math.max(u,v)}`;if(seen.has(key))fail('duplicate edge');seen.add(key);edges.push([u,v]);}return {n,edges};}
const adj=(g,directed)=>{const a=Array.from({length:g.n},()=>[]);for(const [u,v] of g.edges){a[u].push(v);if(!directed)a[v].push(u);}for(const r of a)r.sort((u,v)=>u-v);return a;};
const topo=g=>{const a=adj(g,true),degrees=Array(g.n).fill(0);for(const [,v] of g.edges)degrees[v]++;const q=[];for(let i=0;i<g.n;i++)if(!degrees[i])q.push(i);const order=[];for(let i=0;i<q.length;i++){const v=q[i];order.push(v);for(const w of a[v])if(--degrees[w]===0)q.push(w);}return order.length===g.n?order:null;};
const reach=(g,directed)=>{const a=Array.from({length:g.n},(_,i)=>Array.from({length:g.n},(_,j)=>i===j));for(const [u,v] of g.edges){a[u][v]=true;if(!directed)a[v][u]=true;}for(let k=0;k<g.n;k++)for(let i=0;i<g.n;i++)if(a[i][k])for(let j=0;j<g.n;j++)a[i][j]||=a[k][j];return a;};
const bfs=(a,source)=>{const d=Array(a.length).fill(-1),q=[source];d[source]=0;for(let i=0;i<q.length;i++)for(const w of a[q[i]])if(d[w]<0){d[w]=d[q[i]]+1;q.push(w);}return d;};
const bit=i=>1<<i;
export function directedTransitiveClosure(input){const g=graph(input);return freeze({reachable:freeze(reach(g,true).map(row=>freeze(row)))});}
export function dagTransitiveReduction(input){const g=graph(input);if(!topo(g))fail('transitive reduction requires DAG');const r=reach(g,true),keep=g.edges.filter(([u,v])=>!g.edges.some(([x,w])=>x===u&&w!==v&&r[w][v]));
 return freeze({edges:freeze(keep.map(([from,to])=>freeze({from,to})).sort((a,b)=>a.from-b.from||a.to-b.to))});}
export function longestWeightedDagPath(input){shape(input,['vertexCount','edges','source','target']);const n=integer(input.vertexCount,'vertexCount',2,12),source=integer(input.source,'source',0,n-1),target=integer(input.target,'target',0,n-1);
 if(!Array.isArray(input.edges)||input.edges.length>60)fail('edge budget exceeded');const edges=input.edges.map((e,i)=>{shape(e,['from','to','weight']);const from=integer(e.from,`edge ${i} from`,0,n-1),to=integer(e.to,`edge ${i} to`,0,n-1),weight=integer(e.weight,`edge ${i} weight`,-10000,10000);if(from===to)fail('self-loop');return {from,to,weight};});
 const g=graph({vertexCount:n,edges:edges.map(({from,to})=>({from,to}))}),order=topo(g);if(!order)fail('longest path requires DAG');const d=Array(n).fill(null),parent=Array(n).fill(-1);d[source]=0;
 for(const u of order)if(d[u]!==null)for(const {from,to,weight} of edges)if(from===u){const candidate=d[u]+weight;if(d[to]===null||candidate>d[to]){d[to]=candidate;parent[to]=u;}}
 if(d[target]===null)return freeze({reachable:false,weight:null,path:null});const path=[];let v=target;while(v!==-1){path.push(v);v=parent[v];}return freeze({reachable:true,weight:d[target],path:freeze(path.reverse())});}
export function boundedDirectedSimpleCycles(input){const g=graph(input,['vertexCount','edges'],true,8,40),a=adj(g,true),cycles=[];
 for(let root=0;root<g.n;root++){const visit=(v,used,path)=>{for(const w of a[v]){if(w===root&&path.length>=2){cycles.push(freeze([...path]));continue;}if(w<=root||(used&bit(w)))continue;visit(w,used|bit(w),[...path,w]);}};visit(root,bit(root),[root]);}
 return freeze({cycles:freeze(cycles),count:cycles.length});}
export function exactDirectedFeedbackVertexSet(input){const g=graph(input,['vertexCount','edges'],true,10,50);let best=null;
 for(let mask=0;mask<1<<g.n;mask++){const size=Array.from({length:g.n},(_,v)=>Boolean(mask&bit(v))).filter(Boolean).length;if(best&&size>=best.length)continue;
  const remaining=g.edges.filter(([u,v])=>!(mask&bit(u))&&!(mask&bit(v))),degrees=Array(g.n).fill(0),a=Array.from({length:g.n},()=>[]);for(const [u,v] of remaining){degrees[v]++;a[u].push(v);}
  const q=[];for(let v=0;v<g.n;v++)if(!(mask&bit(v))&&degrees[v]===0)q.push(v);for(let j=0;j<q.length;j++)for(const w of a[q[j]])if(--degrees[w]===0)q.push(w);
  if(q.length===g.n-size)best=Array.from({length:g.n},(_,v)=>v).filter(v=>mask&bit(v));
 }return freeze({size:best.length,vertices:freeze(best)});}
export function undirectedGlobalEdgeConnectivity(input){const g=graph(input,['vertexCount','edges'],false,12,60),n=g.n;if(n===1)return freeze({cutSize:0,partition:freeze([0])});let best=Infinity,partition=[];
 for(let mask=1;mask<(1<<(n-1));mask++){let crossing=0;for(const [u,v] of g.edges)if(Boolean(mask&bit(u))!==Boolean(mask&bit(v)))crossing++;
  if(crossing<best){best=crossing;partition=Array.from({length:n},(_,i)=>i).filter(i=>mask&bit(i));}}
 return freeze({cutSize:best,partition:freeze(partition)});}
export function graphEccentricities(input){const g=graph(input,['vertexCount','edges'],false),a=adj(g,false),eccentricities=[];
 for(let v=0;v<g.n;v++){const d=bfs(a,v);eccentricities.push(d.includes(-1)?null:Math.max(...d));}
 return freeze({eccentricities:freeze(eccentricities),connected:eccentricities.every(v=>v!==null)});}
export function unweightedGraphCenter(input){const g=graph(input,['vertexCount','edges'],false),a=adj(g,false),e=[];for(let v=0;v<g.n;v++){const d=bfs(a,v);if(d.includes(-1))fail('graph center requires connected graph');e.push(Math.max(...d));}
 const radius=Math.min(...e);return freeze({radius,centers:freeze(e.flatMap((v,i)=>v===radius?[i]:[]))});}
export function independencePolynomial(input){const g=graph(input,['vertexCount','edges'],false,16,80),counts=Array(g.n+1).fill(0);for(let mask=0;mask<1<<g.n;mask++)if(g.edges.every(([u,v])=>!(mask&bit(u))||!(mask&bit(v)))){let n=0;for(let b=mask;b;b&=b-1)n++;counts[n]++;}
 return freeze({coefficients:freeze(counts)});}
export function undirectedTriangleCount(input){const g=graph(input,['vertexCount','edges'],false,40,500),edge=new Set(g.edges.map(([u,v])=>`${Math.min(u,v)}:${Math.max(u,v)}`));let count=0;
 for(let a=0;a<g.n;a++)for(let b=a+1;b<g.n;b++)if(edge.has(`${a}:${b}`))for(let c=b+1;c<g.n;c++)if(edge.has(`${a}:${c}`)&&edge.has(`${b}:${c}`))count++;
 return freeze({triangles:count});}
function bareiss(a){const n=a.length;if(n===0)return 1n;let sign=1n,prev=1n;for(let k=0;k<n-1;k++){let p=k;while(p<n&&a[p][k]===0n)p++;if(p===n)return 0n;if(p!==k){[a[p],a[k]]=[a[k],a[p]];sign=-sign;}const pivot=a[k][k];for(let i=k+1;i<n;i++)for(let j=k+1;j<n;j++){const numerator=a[i][j]*pivot-a[i][k]*a[k][j];if(numerator%prev!==0n)throw new Error('nonintegral Bareiss quotient');a[i][j]=numerator/prev;}for(let i=k+1;i<n;i++)a[i][k]=0n;prev=pivot;}return sign*a[n-1][n-1];}
export function exactRootedOutArborescenceCount(input){shape(input,['vertexCount','edges','root']);const g=graph({vertexCount:input.vertexCount,edges:input.edges},['vertexCount','edges'],true,10,60),root=integer(input.root,'root',0,g.n-1);
 const lap=Array.from({length:g.n},()=>Array(g.n).fill(0n));for(const [u,v] of g.edges){lap[v][v]++;lap[v][u]--;}
 const minor=lap.filter((_,i)=>i!==root).map(row=>row.filter((_,j)=>j!==root));return freeze({arborescences:bareiss(minor).toString()});}
export function undirectedCoreDecomposition(input){const g=graph(input,['vertexCount','edges'],false,40,500),a=adj(g,false),degree=a.map(row=>row.length),remaining=Array(g.n).fill(true),cores=Array(g.n).fill(0);let level=0;
 for(let step=0;step<g.n;step++){let v=-1;for(let i=0;i<g.n;i++)if(remaining[i]&&(v<0||degree[i]<degree[v]))v=i;level=Math.max(level,degree[v]);cores[v]=level;remaining[v]=false;for(const w of a[v])if(remaining[w])degree[w]--; }
 return freeze({coreNumbers:freeze(cores),degeneracy:Math.max(...cores)});}
