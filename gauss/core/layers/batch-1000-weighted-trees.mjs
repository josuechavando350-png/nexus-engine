// Weighted undirected trees; integer path metrics use exact BigInt sums.
import {object,arr,int,freeze,entries,range,rational} from './batch-1000-common.mjs';
const example={n:6,root:0,edges:[[0,1,3],[0,2,5],[1,3,2],[1,4,4],[2,5,6]]};
function tree(x){object(x,['n','root','edges']);const n=int(x.n,'n',1,24),root=int(x.root,'root',0,n-1),es=arr(x.edges,'edges',n-1,n-1),a=range(n).map(()=>[]),seen=new Set();for(const[k,e]of es.entries()){arr(e,`edge[${k}]`,3,3);const u=int(e[0],'u',0,n-1),v=int(e[1],'v',0,n-1),w=int(e[2],'weight',0,10000),key=`${Math.min(u,v)},${Math.max(u,v)}`;if(u===v||seen.has(key))throw new TypeError('duplicate/self-loop tree edge');seen.add(key);a[u].push([v,w]);a[v].push([u,w]);}const seenV=new Set([root]),queue=[root],parent=Array(n).fill(-1),pw=Array(n).fill(0);for(let i=0;i<queue.length;i++)for(const[v,w]of a[queue[i]])if(!seenV.has(v)){seenV.add(v);queue.push(v);parent[v]=queue[i];pw[v]=w;}if(seenV.size!==n)throw new TypeError('tree must be connected');return {n,root,es,a,parent,pw,queue};}
function distances(t,s){const d=Array(t.n).fill(null),p=Array(t.n).fill(-1),pw=Array(t.n).fill(0),queue=[s];d[s]=0n;for(let i=0;i<queue.length;i++)for(const[v,w]of t.a[queue[i]])if(d[v]===null){d[v]=d[queue[i]]+BigInt(w);p[v]=queue[i];pw[v]=w;queue.push(v);}return {d,p,pw};}
function dm(t){return range(t.n).map(i=>distances(t,i).d);}
const fmt=a=>a.map(String),summary=t=>dm(t).map(row=>row.reduce((s,v)=>s+v,0n));
const pair=x=>{object(x,['tree','a','b']);const t=tree(x.tree);return [t,int(x.a,'a',0,t.n-1),int(x.b,'b',0,t.n-1)];};
function path(t,s,e){const {p,pw}=distances(t,s),edges=[];for(let u=e;u!==s;u=p[u])edges.push(pw[u]);return edges.reverse();}
const base=x=>tree(x);
export function weightedTreeTotalWeight(x){const t=base(x);return freeze({weight:String(t.es.reduce((s,e)=>s+BigInt(e[2]),0n))});}
export function weightedTreeMinimumEdge(x){const t=base(x);return freeze({weight:t.es.length?Math.min(...t.es.map(e=>e[2])):null});}
export function weightedTreeMaximumEdge(x){const t=base(x);return freeze({weight:t.es.length?Math.max(...t.es.map(e=>e[2])):null});}
export function weightedTreeSortedEdges(x){const t=base(x);return freeze({edges:t.es.map(([u,v,w])=>[Math.min(u,v),Math.max(u,v),w]).sort((a,b)=>a[2]-b[2]||a[0]-b[0]||a[1]-b[1])});}
export function weightedTreeRootDistances(x){const t=base(x);return freeze({distances:fmt(distances(t,t.root).d)});}
export function weightedTreePairDistance(x){const[t,a,b]=pair(x);return freeze({distance:String(distances(t,a).d[b])});}
export function weightedTreeDistanceMatrix(x){const t=base(x);return freeze({distances:dm(t).map(fmt)});}
export function weightedTreeEccentricities(x){const t=base(x);return freeze({eccentricities:fmt(dm(t).map(row=>row.reduce((a,b)=>a>b?a:b,0n)))});}
export function weightedTreeRadius(x){const t=base(x),ecc=dm(t).map(row=>row.reduce((a,b)=>a>b?a:b,0n));return freeze({radius:String(ecc.reduce((a,b)=>a<b?a:b))});}
export function weightedTreeCenters(x){const t=base(x),ecc=dm(t).map(row=>row.reduce((a,b)=>a>b?a:b,0n)),r=ecc.reduce((a,b)=>a<b?a:b);return freeze({vertices:range(t.n).filter(i=>ecc[i]===r)});}
export function weightedTreeDiameter(x){const t=base(x),d=dm(t);let max=0n;for(let i=0;i<t.n;i++)for(let j=i+1;j<t.n;j++)if(d[i][j]>max)max=d[i][j];return freeze({diameter:String(max)});}
export function weightedTreeDiameterPair(x){const t=base(x),d=dm(t);let best=null,v=-1n;for(let i=0;i<t.n;i++)for(let j=i+1;j<t.n;j++)if(d[i][j]>v){v=d[i][j];best=[i,j];}return freeze({vertices:best,diameter:String(v<0n?0n:v)});}
export function weightedTreeWienerIndex(x){const t=base(x),d=dm(t);let s=0n;for(let i=0;i<t.n;i++)for(let j=i+1;j<t.n;j++)s+=d[i][j];return freeze({index:String(s)});}
export function weightedTreeMeanPairDistance(x){const t=base(x),d=dm(t);let s=0n;for(let i=0;i<t.n;i++)for(let j=i+1;j<t.n;j++)s+=d[i][j];const count=BigInt(t.n*(t.n-1)/2);return freeze({mean:count?`${rational(s,count).n}/${rational(s,count).d}`:null});}
export function weightedTreeFarness(x){const t=base(x);return freeze({sums:fmt(summary(t))});}
export function weightedTreeMedianVertices(x){const t=base(x),s=summary(t),best=s.reduce((a,b)=>a<b?a:b);return freeze({vertices:range(t.n).filter(i=>s[i]===best)});}
export function weightedTreeRootLeafDistances(x){const t=base(x),d=distances(t,t.root).d;return freeze({leaves:range(t.n).filter(i=>i!==t.root&&t.a[i].length===1||t.n===1&&i===t.root).map(v=>({vertex:v,distance:String(d[v])}))});}
export function weightedTreeMinimumRootLeaf(x){const t=base(x),d=distances(t,t.root).d,leaves=range(t.n).filter(i=>i!==t.root&&t.a[i].length===1||t.n===1&&i===t.root);return freeze({distance:String(leaves.map(i=>d[i]).reduce((a,b)=>a<b?a:b))});}
export function weightedTreeMaximumRootLeaf(x){const t=base(x),d=distances(t,t.root).d,leaves=range(t.n).filter(i=>i!==t.root&&t.a[i].length===1||t.n===1&&i===t.root);return freeze({distance:String(leaves.map(i=>d[i]).reduce((a,b)=>a>b?a:b))});}
export function weightedTreePathWeights(x){const[t,a,b]=pair(x);return freeze({weights:path(t,a,b)});}
export function weightedTreePathMax(x){const[t,a,b]=pair(x),ws=path(t,a,b);return freeze({weight:ws.length?Math.max(...ws):null});}
export function weightedTreePathMin(x){const[t,a,b]=pair(x),ws=path(t,a,b);return freeze({weight:ws.length?Math.min(...ws):null});}
export function weightedTreePathProduct(x){const[t,a,b]=pair(x);return freeze({product:String(path(t,a,b).reduce((p,w)=>p*BigInt(w),1n))});}
export function weightedTreeThresholdComponents(x){object(x,['tree','threshold']);const t=base(x.tree),k=int(x.threshold,'threshold',0,10000),p=range(t.n);function find(i){while(i!==p[i])i=p[i]=p[p[i]];return i;}for(const[u,v,w]of t.es)if(w<=k)p[find(u)]=find(v);const groups=new Map();for(const i of range(t.n)){const r=find(i);if(!groups.has(r))groups.set(r,[]);groups.get(r).push(i);}return freeze({components:[...groups.values()].sort((a,b)=>a[0]-b[0])});}
export function weightedTreeThresholdPairCount(x){object(x,['tree','threshold']);const t=base(x.tree),k=int(x.threshold,'threshold',0,10000),p=range(t.n),sz=Array(t.n).fill(1);function find(i){while(i!==p[i])i=p[i]=p[p[i]];return i;}let s=0n;for(const[u,v,w]of t.es)if(w<=k){const a=find(u),b=find(v);if(a!==b){s+=BigInt(sz[a])*BigInt(sz[b]);p[a]=b;sz[b]+=sz[a];}}return freeze({pairs:String(s)});}
const AB={tree:example,a:3,b:5},TH={tree:example,threshold:4};
const specs=[
 ['EDGE_SUM','Exact total edge weight',weightedTreeTotalWeight,example],
 ['EDGE_MIN','Minimum edge weight or null for a singleton tree',weightedTreeMinimumEdge,example],
 ['EDGE_MAX','Maximum edge weight or null for a singleton tree',weightedTreeMaximumEdge,example],
 ['EDGE_SORT','Canonical increasing edge-weight list',weightedTreeSortedEdges,example],
 ['ROOT_DISTANCES','Exact shortest weighted distances from root',weightedTreeRootDistances,example],
 ['PAIR_DISTANCE','Exact unique-path weighted distance between vertices',weightedTreePairDistance,AB],
 ['DISTANCE_MATRIX','All-pairs exact weighted tree metric',weightedTreeDistanceMatrix,example],
 ['ECCENTRICITIES','All weighted vertex eccentricities',weightedTreeEccentricities,example],
 ['RADIUS','Minimum weighted vertex eccentricity',weightedTreeRadius,example],
 ['CENTERS','All vertices attaining weighted tree radius',weightedTreeCenters,example],
 ['DIAMETER','Maximum pairwise weighted tree distance',weightedTreeDiameter,example],
 ['DIAMETER_WITNESS','Canonical endpoint witness of weighted diameter',weightedTreeDiameterPair,example],
 ['WIENER_INDEX','Sum of all unordered pairwise tree distances',weightedTreeWienerIndex,example],
 ['PAIR_MEAN','Exact rational average unordered pairwise distance',weightedTreeMeanPairDistance,example],
 ['FARNESS','Sum of distances from each vertex to every vertex',weightedTreeFarness,example],
 ['MEDIAN','Weighted metric one-median vertex set',weightedTreeMedianVertices,example],
 ['ROOT_LEAF_DISTANCES','Root-to-terminal-leaf exact weighted distances',weightedTreeRootLeafDistances,example],
 ['ROOT_LEAF_MIN','Minimum root-to-terminal-leaf weighted distance',weightedTreeMinimumRootLeaf,example],
 ['ROOT_LEAF_MAX','Maximum root-to-terminal-leaf weighted distance',weightedTreeMaximumRootLeaf,example],
 ['PATH_WEIGHTS','Ordered unique-path edge weights',weightedTreePathWeights,AB],
 ['PATH_MAX','Maximum edge weight along unique vertex path',weightedTreePathMax,AB],
 ['PATH_MIN','Minimum edge weight along unique vertex path',weightedTreePathMin,AB],
 ['PATH_PRODUCT','Exact edge-weight product along unique vertex path',weightedTreePathProduct,AB],
 ['THRESHOLD_COMPONENTS','Connected component partition retaining edges <= threshold',weightedTreeThresholdComponents,TH],
 ['THRESHOLD_PAIRS','Count unordered vertex pairs connected below threshold',weightedTreeThresholdPairCount,TH],
];
export const WEIGHTED_TREES_1000=entries(specs,'CS.WEIGHTED_TREES','COMPUTER_SCIENCE',901);
