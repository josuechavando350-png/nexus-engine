import {fields,graph,int,pack,choose} from './batch-400-common.mjs';
const G=x=>graph(x);
const N=x=>{const {n,edges}=G(x),a=Array.from({length:n},()=>Array(n).fill(0));for(const[u,v]of edges)a[u][v]=a[v][u]=1;return {n,edges,a,d:a.map(r=>r.reduce((s,v)=>s+v,0))};};
const V=x=>pack({value:x});
const subsets=(n,cb)=>{for(let mask=0;mask<(1<<n);mask++)cb(mask);};
const bits=m=>{let n=0;for(;m;m&=m-1)n++;return n;};
const members=(n,m)=>Array.from({length:n},(_,i)=>i).filter(i=>m>>i&1);
const connected=(a,m)=>{const vs=members(a.length,m);if(!vs.length)return false;let seen=1<<vs[0],stack=[vs[0]];while(stack.length){const v=stack.pop();for(const u of vs)if(a[v][u]&&!(seen>>u&1)){seen|=1<<u;stack.push(u);}}return seen===m;};
const independent=(a,m)=>{const vs=members(a.length,m);return vs.every((v,i)=>vs.slice(i+1).every(u=>!a[v][u]));};
const degrees=x=>N(x).d;
export function graphDegreeSequence(x){return pack({degrees:degrees(x)});}
export function graphDegreeHistogram(x){const {n,d}=N(x),hist=Array(n).fill(0);for(const v of d)hist[v]++;return pack({counts:hist});}
export function graphIsolatedVertices(x){return pack({vertices:degrees(x).flatMap((v,i)=>v===0?[i]:[])});}
export function graphPendantVertices(x){return pack({vertices:degrees(x).flatMap((v,i)=>v===1?[i]:[])});}
export function graphEdgeDensity(x){const {n,edges}=N(x),den=n*(n-1)/2,num=edges.length;if(n===1)return pack({numerator:'0',denominator:'1'});const gcd=(a,b)=>b?gcd(b,a%b):a;const g=gcd(num,den)||1;return pack({numerator:String(num/g),denominator:String(den/g)});}
function sized(x,pred){fields(x,['vertexCount','edges','k']);const {n,a}=N({vertexCount:x.vertexCount,edges:x.edges}),k=int(x.k,'k',0,n);let c=0n;subsets(n,m=>{if(bits(m)===k&&pred(a,m))c++;});return V(c);}
export function graphConnectedInducedK(x){return sized(x,connected);}
export function graphIndependentK(x){return sized(x,independent);}
export function graphVertexCoverK(x){return sized(x,(a,m)=>{for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++)if(a[i][j]&&!(m>>i&1)&&!(m>>j&1))return false;return true;});}
export function graphEdgeCoverK(x){fields(x,['vertexCount','edges','k']);const {n,edges}=G({vertexCount:x.vertexCount,edges:x.edges});const k=int(x.k,'k',0,16);if(edges.length>16)throw new RangeError('edge subset budget max 16');let c=0n;subsets(edges.length,m=>{if(bits(m)!==k)return;let covered=0;for(let i=0;i<edges.length;i++)if(m>>i&1){covered|=1<<edges[i][0];covered|=1<<edges[i][1];}if(covered===(1<<n)-1)c++;});return V(c);}
export function graphMaximalIndependentCount(x){const {n,a}=N(x);let c=0n;subsets(n,m=>{if(!independent(a,m))return;for(let i=0;i<n;i++)if(!(m>>i&1)&&independent(a,m|1<<i))return;c++;});return V(c);}
export function graphMaximalCliqueCount(x){const {n,a}=N(x);let c=0n;const clique=m=>members(n,m).every((v,i,vs)=>vs.slice(i+1).every(u=>a[v][u]));subsets(n,m=>{if(!m||!clique(m))return;for(let i=0;i<n;i++)if(!(m>>i&1)&&clique(m|1<<i))return;c++;});return V(c);}
export function graphFourCycleCount(x){const {n,a}=N(x);let count=0n;for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){let common=0;for(let k=0;k<n;k++)if(a[i][k]&&a[j][k])common++;count+=choose(common,2);}return V(count/2n);}
export function graphInducedFourCycleCount(x){const {n,a}=N(x);let c=0n;for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)for(let k=j+1;k<n;k++)for(let l=k+1;l<n;l++){const vs=[i,j,k,l],deg=vs.map(v=>vs.reduce((s,u)=>s+a[v][u],0));if(deg.every(d=>d===2))c++;}return V(c);}
export function graphFourCliqueCount(x){const {n,a}=N(x);let c=0n;for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)for(let k=j+1;k<n;k++)for(let l=k+1;l<n;l++)if(a[i][j]&&a[i][k]&&a[i][l]&&a[j][k]&&a[j][l]&&a[k][l])c++;return V(c);}
export function graphWedgeCount(x){return V(degrees(x).reduce((s,d)=>s+BigInt(d*(d-1)/2),0n));}
export function graphOpenWedgeCount(x){const {n,a,d}=N(x);let c=0n;for(let v=0;v<n;v++)for(let u=0;u<n;u++)for(let w=u+1;w<n;w++)if(a[v][u]&&a[v][w]&&!a[u][w])c++;return V(c);}
export function graphFirstZagrebIndex(x){return V(degrees(x).reduce((s,d)=>s+BigInt(d*d),0n));}
export function graphSecondZagrebIndex(x){const {edges,d}=N(x);return V(edges.reduce((s,[u,v])=>s+BigInt(d[u]*d[v]),0n));}
export function graphAdjacencyMatrix(x){return pack({matrix:N(x).a});}
export function graphOrientedIncidenceMatrix(x){const {n,edges}=G(x);return pack({matrix:Array.from({length:n},(_,v)=>edges.map(([a,b])=>v===Math.min(a,b)?-1:v===Math.max(a,b)?1:0))});}
export function graphComplementEdges(x){const {n,a}=N(x),edges=[];for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(!a[i][j])edges.push({from:i,to:j});return pack({edges});}
export function graphLineGraph(x){const {edges}=G(x),pairs=[];for(let i=0;i<edges.length;i++)for(let j=i+1;j<edges.length;j++)if(edges[i].some(u=>edges[j].includes(u)))pairs.push({from:i,to:j});return pack({vertexCount:edges.length,edges:pairs});}
export function graphShortestPathCounts(x){fields(x,['vertexCount','edges','source']);const {n,a}=N({vertexCount:x.vertexCount,edges:x.edges}),source=int(x.source,'source',0,n-1),dist=Array(n).fill(-1),count=Array(n).fill(0n),queue=[source];dist[source]=0;count[source]=1n;for(let q=0;q<queue.length;q++){const v=queue[q];for(let u=0;u<n;u++)if(a[v][u]){if(dist[u]<0){dist[u]=dist[v]+1;queue.push(u);}if(dist[u]===dist[v]+1)count[u]+=count[v];}}return pack({distances:dist,pathCounts:count});}
export function graphDistanceSum(x){const {n,a}=N(x);let sum=0n;for(let start=0;start<n;start++){const d=Array(n).fill(-1),queue=[start];d[start]=0;for(let z=0;z<queue.length;z++){const v=queue[z];for(let u=0;u<n;u++)if(a[v][u]&&d[u]<0){d[u]=d[v]+1;queue.push(u);}}if(d.some(v=>v<0))return pack({connected:false,value:null});sum+=BigInt(d.reduce((s,v)=>s+v,0));}return pack({connected:true,value:String(sum/2n)});}
export function graphClosedWalksK(x){fields(x,['vertexCount','edges','length']);const {n,a}=N({vertexCount:x.vertexCount,edges:x.edges}),k=int(x.length,'length',0,12);let m=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>BigInt(i===j)));for(let z=0;z<k;z++)m=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>m[i].reduce((s,v,t)=>s+v*BigInt(a[t][j]),0n)));return V(m.reduce((s,r,i)=>s+r[i],0n));}
const e=[{from:0,to:1},{from:1,to:2},{from:2,to:3},{from:3,to:0},{from:0,to:2}],sample={vertexCount:4,edges:e};
const definitions=[
 ['GRAPH_DEGREE_SEQUENCE','Exact undirected vertex degree sequence',graphDegreeSequence,sample],
 ['GRAPH_DEGREE_HIST','Undirected degree-frequency distribution',graphDegreeHistogram,sample],
 ['GRAPH_ISOLATED','All degree-zero vertex witnesses',graphIsolatedVertices,sample],
 ['GRAPH_PENDANT','All degree-one vertex witnesses',graphPendantVertices,sample],
 ['GRAPH_DENSITY_RATIONAL','Reduced rational edge density',graphEdgeDensity,sample],
 ['GRAPH_CONNECTED_K','Count connected induced vertex sets of cardinality k',graphConnectedInducedK,{...sample,k:3}],
 ['GRAPH_INDEPENDENT_K','Count independent vertex sets of cardinality k',graphIndependentK,{...sample,k:2}],
 ['GRAPH_VERTEX_COVER_K','Count vertex covers of cardinality k',graphVertexCoverK,{...sample,k:3}],
 ['GRAPH_EDGE_COVER_K','Count edge covers of cardinality k',graphEdgeCoverK,{...sample,k:3}],
 ['GRAPH_MAXIMAL_INDEP','Count inclusion-maximal independent vertex sets',graphMaximalIndependentCount,sample],
 ['GRAPH_MAXIMAL_CLIQUE','Count inclusion-maximal nonempty cliques',graphMaximalCliqueCount,sample],
 ['GRAPH_CYCLES_FOUR','Exact count of four-cycles modulo rotation and reversal',graphFourCycleCount,sample],
 ['GRAPH_INDUCED_CYCLES_FOUR','Exact count of chordless induced four-cycles',graphInducedFourCycleCount,sample],
 ['GRAPH_CLIQUES_FOUR','Count complete four-vertex subgraphs',graphFourCliqueCount,sample],
 ['GRAPH_WEDGES','Count unordered two-edge wedges centered at vertices',graphWedgeCount,sample],
 ['GRAPH_OPEN_WEDGES','Count open connected vertex triples with designated center',graphOpenWedgeCount,sample],
 ['GRAPH_ZAGREB_FIRST','First graph Zagreb degree-square index',graphFirstZagrebIndex,sample],
 ['GRAPH_ZAGREB_SECOND','Second graph Zagreb edge degree-product index',graphSecondZagrebIndex,sample],
 ['GRAPH_ADJACENCY_MATRIX','Undirected simple adjacency matrix',graphAdjacencyMatrix,sample],
 ['GRAPH_INCIDENCE_MATRIX','Canonical oriented vertex-edge incidence matrix',graphOrientedIncidenceMatrix,sample],
 ['GRAPH_COMPLEMENT','Sorted nonedge list of simple graph complement',graphComplementEdges,sample],
 ['GRAPH_LINE_GRAPH','Edge intersection line graph',graphLineGraph,sample],
 ['GRAPH_SHORTEST_PATH_COUNTS','BFS distances and number of shortest paths from source',graphShortestPathCounts,{...sample,source:0}],
 ['GRAPH_DISTANCE_SUM','Wiener sum of unordered connected vertex-pair distances',graphDistanceSum,sample],
 ['GRAPH_CLOSED_WALKS','Trace of adjacency power for exact length k',graphClosedWalksK,{...sample,length:4}],
];
export const EXACT_GRAPHS_400=Object.freeze(definitions.map(([code,description,execute,input],i)=>Object.freeze({id:`GAUSS.CS.${code}.${301+i}`,domain:'COMPUTER_SCIENCE',description,execute,input:Object.freeze(input)})));
