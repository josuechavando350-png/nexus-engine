import {obj,int,arr,result,entries,lexLess} from './batch-600-common.mjs';
function hypergraph(x){obj(x,['vertexCount','edges']);const n=int(x.vertexCount,'vertexCount',1,9),edges=arr(x.edges,'edges',0,100),seen=new Set(),masks=[];
 for(let k=0;k<edges.length;k++){const edge=arr(edges[k],`edge[${k}]`,1,n).map((v,j)=>int(v,`edge[${k}][${j}]`,0,n-1));if(new Set(edge).size!==edge.length)throw new TypeError('repeated vertex in hyperedge');const mask=edge.reduce((m,v)=>m|1<<v,0);if(seen.has(mask))throw new TypeError('duplicate hyperedge');seen.add(mask);masks.push(mask);}return {n,edges:masks.sort((a,b)=>a-b)};
}
const H=x=>hypergraph(x),pop=x=>{let n=0;while(x){x&=x-1;n++;}return n;};
const vertices=(n,m)=>Array.from({length:n},(_,i)=>i).filter(i=>m>>i&1);
const masks=x=>{const h=H(x);return {h,all:1<<h.n};};
const hit=(h,s)=>h.edges.every(e=>e&s);
const independent=(h,s)=>h.edges.every(e=>(e&s)!==e);
const disjoint=(selected)=>selected.every((e,i)=>selected.slice(i+1).every(f=>!(e&f)));
const colorGood=(h,s)=>h.edges.every(e=>(e&s)!==0&&(e&~s)!==0);
function best(h,good){let found=null;for(let s=0;s<1<<h.n;s++)if(good(s)){const v=vertices(h.n,s);if(found===null||v.length<found.length||v.length===found.length&&lexLess(v,found))found=v;}return found;}
function components(h){const adjacency=Array.from({length:h.n},()=>new Set());for(const e of h.edges){const vs=vertices(h.n,e);for(const i of vs)for(const j of vs)if(i!==j)adjacency[i].add(j);}const seen=new Set(),out=[];for(let i=0;i<h.n;i++)if(!seen.has(i)){const q=[i];seen.add(i);for(let k=0;k<q.length;k++)for(const j of adjacency[q[k]])if(!seen.has(j)){seen.add(j);q.push(j);}out.push(q.sort((a,b)=>a-b));}return out;}
export function vertexDegrees(x){const h=H(x);return result({degrees:Array.from({length:h.n},(_,i)=>h.edges.filter(e=>e>>i&1).length)});}
export function edgeSizeHistogram(x){const h=H(x),count=Array(h.n+1).fill(0);for(const e of h.edges)count[pop(e)]++;return result({counts:count});}
export function hypergraphRank(x){const h=H(x);return result({rank:h.edges.reduce((m,e)=>Math.max(m,pop(e)),0)});}
export function coveredVertices(x){const h=H(x);return result({vertices:vertices(h.n,h.edges.reduce((a,b)=>a|b,0))});}
export function commonVertices(x){const h=H(x);return result({vertices:vertices(h.n,h.edges.length?h.edges.reduce((a,b)=>a&b):0)});}
export function minimalHyperedges(x){const h=H(x);return result({edges:h.edges.filter(e=>!h.edges.some(f=>f!==e&&(e&f)===f)).map(e=>vertices(h.n,e))});}
export function maximalHyperedges(x){const h=H(x);return result({edges:h.edges.filter(e=>!h.edges.some(f=>f!==e&&(e&f)===e)).map(e=>vertices(h.n,e))});}
export function incidenceMatrix(x){const h=H(x);return result({matrix:Array.from({length:h.n},(_,i)=>h.edges.map(e=>Number(!!(e>>i&1))))});}
export function primalAdjacency(x){const h=H(x);return result({adjacency:Array.from({length:h.n},(_,i)=>Array.from({length:h.n},(_,j)=>Number(i!==j&&h.edges.some(e=>(e>>i&1)&&(e>>j&1)))))});}
export function edgeIntersectionGraph(x){const h=H(x);return result({edges:h.edges.flatMap((e,i)=>h.edges.slice(i+1).flatMap((f,j)=>e&f?[[i,i+1+j]]:[]))});}
export function hypergraphComponents(x){return result({components:components(H(x))});}
export function isolatedVertices(x){const h=H(x),union=h.edges.reduce((a,b)=>a|b,0);return result({vertices:vertices(h.n,((1<<h.n)-1)^union)});}
export function independentSetCount(x){const {h,all}=masks(x);let count=0n;for(let s=0;s<all;s++)if(independent(h,s))count++;return result({count:String(count)});}
export function largestIndependentSet(x){const h=H(x);let found=[];for(let s=0;s<1<<h.n;s++)if(independent(h,s)){const v=vertices(h.n,s);if(v.length>found.length||v.length===found.length&&lexLess(v,found))found=v;}return result({size:found.length,vertices:found});}
export function hittingSetCount(x){const {h,all}=masks(x);let count=0n;for(let s=0;s<all;s++)if(hit(h,s))count++;return result({count:String(count)});}
export function minimumHittingSet(x){const h=H(x),found=best(h,s=>hit(h,s));return result({size:found.length,vertices:found});}
export function minimalHittingSets(x){const h=H(x),sets=[];for(let s=0;s<1<<h.n;s++)if(hit(h,s)&&vertices(h.n,s).every(i=>!hit(h,s&~(1<<i))))sets.push(vertices(h.n,s));return result({sets});}
export function maxEdgePacking(x){const h=H(x);if(h.edges.length>18)throw new RangeError('edge packing enumerates at most 18 hyperedges');let best=[];for(let s=0;s<1<<h.edges.length;s++){const chosen=h.edges.filter((_,i)=>s>>i&1);if(disjoint(chosen)){const idx=h.edges.flatMap((_,i)=>s>>i&1?[i]:[]);if(idx.length>best.length||idx.length===best.length&&lexLess(idx,best))best=idx;}}return result({size:best.length,indices:best});}
export function countEdgePackings(x){const h=H(x);if(h.edges.length>18)throw new RangeError('edge packing enumerates at most 18 hyperedges');let count=0n;for(let s=0;s<1<<h.edges.length;s++)if(disjoint(h.edges.filter((_,i)=>s>>i&1)))count++;return result({count:String(count)});}
export function minimumEdgeCover(x){const h=H(x);if(h.edges.length>18)throw new RangeError('edge cover enumerates at most 18 hyperedges');let found=null;for(let s=0;s<1<<h.edges.length;s++){const selected=h.edges.flatMap((e,i)=>s>>i&1?[[e,i]]:[]);if(selected.reduce((m,[e])=>m|e,0)===(1<<h.n)-1){const idx=selected.map(([,i])=>i);if(found===null||idx.length<found.length||idx.length===found.length&&lexLess(idx,found))found=idx;}}return result({indices:found,count:found?.length??null});}
export function twoColorable(x){const h=H(x);let witness=null;for(let s=0;s<1<<h.n;s++)if(colorGood(h,s)){witness=vertices(h.n,s);break;}return result({twoColorable:witness!==null,colorOne:witness});}
export function properTwoColoringCount(x){const {h,all}=masks(x);let count=0n;for(let s=0;s<all;s++)if(colorGood(h,s))count++;return result({count:String(count)});}
export function inducedHypergraph(x){obj(x,['hypergraph','vertices']);const h=H(x.hypergraph),vs=arr(x.vertices,'vertices',0,h.n).map((v,i)=>int(v,`vertices[${i}]`,0,h.n-1));if(new Set(vs).size!==vs.length)throw new TypeError('duplicate vertices');const selected=vs.reduce((s,v)=>s|1<<v,0);return result({vertexCount:h.n,edges:h.edges.filter(e=>(e&selected)===e).map(e=>vertices(h.n,e))});}
export function deleteVertex(x){obj(x,['hypergraph','vertex']);const h=H(x.hypergraph),v=int(x.vertex,'vertex',0,h.n-1);return result({vertexCount:h.n,edges:h.edges.filter(e=>!(e>>v&1)).map(e=>vertices(h.n,e))});}
export function independentSetPolynomial(x){const {h,all}=masks(x),coefficients=Array(h.n+1).fill(0n);for(let s=0;s<all;s++)if(independent(h,s))coefficients[pop(s)]++;return result({coefficients:coefficients.map(String)});}
const sample={vertexCount:5,edges:[[0,1,2],[2,3],[3,4],[0,4]]};
const defs=[
 ['HYPER_VERTEX_DEGREES','Hyperedge incidence degree of every vertex',vertexDegrees,sample],
 ['HYPER_EDGE_SIZE_HIST','Hyperedge cardinality frequency distribution',edgeSizeHistogram,sample],
 ['HYPER_RANK','Maximum cardinality among all hyperedges',hypergraphRank,sample],
 ['HYPER_COVERED_VERTICES','Union of all hyperedge vertex sets',coveredVertices,sample],
 ['HYPER_COMMON_VERTICES','Intersection of all hyperedge vertex sets',commonVertices,sample],
 ['HYPER_MINIMAL_EDGES','Inclusion-minimal hyperedges',minimalHyperedges,sample],
 ['HYPER_MAXIMAL_EDGES','Inclusion-maximal hyperedges',maximalHyperedges,sample],
 ['HYPER_INCIDENCE_MATRIX','Vertex-edge binary incidence matrix',incidenceMatrix,sample],
 ['HYPER_PRIMAL_GRAPH','Pairwise co-occurrence graph of hypergraph vertices',primalAdjacency,sample],
 ['HYPER_INTERSECTION_GRAPH','Intersection graph of nonempty-overlap hyperedges',edgeIntersectionGraph,sample],
 ['HYPER_COMPONENTS','Connected components under hyperedge adjacency',hypergraphComponents,sample],
 ['HYPER_ISOLATED','Vertices that belong to no hyperedge',isolatedVertices,sample],
 ['HYPER_INDEPENDENT_COUNT','Exact count of subsets containing no full hyperedge',independentSetCount,sample],
 ['HYPER_MAX_INDEPENDENT','Maximum independent vertex subset with witness',largestIndependentSet,sample],
 ['HYPER_TRANSVERSAL_COUNT','Exact count of vertex subsets meeting every edge',hittingSetCount,sample],
 ['HYPER_MIN_TRANSVERSAL','Minimum-cardinality hitting set with witness',minimumHittingSet,sample],
 ['HYPER_MINIMAL_TRANSVERSALS','All inclusion-minimal vertex hitting sets',minimalHittingSets,sample],
 ['HYPER_MAX_EDGE_PACKING','Maximum collection of pairwise disjoint hyperedges',maxEdgePacking,sample],
 ['HYPER_EDGE_PACKING_COUNT','Exact number of pairwise-disjoint edge collections',countEdgePackings,sample],
 ['HYPER_MIN_EDGE_COVER','Minimum edge collection covering every vertex',minimumEdgeCover,sample],
 ['HYPER_TWO_COLORABLE','Property-B two-coloring witness with no monochromatic edge',twoColorable,sample],
 ['HYPER_TWO_COLORINGS','Exact number of proper two-color assignments',properTwoColoringCount,sample],
 ['HYPER_INDUCED','Induced edge-subset hypergraph on supplied vertices',inducedHypergraph,{hypergraph:sample,vertices:[0,1,2,4]}],
 ['HYPER_DELETE_VERTEX','Hypergraph vertex deletion discarding incident hyperedges',deleteVertex,{hypergraph:sample,vertex:2}],
 ['HYPER_INDEPENDENCE_POLY','Exact independence polynomial coefficients by vertex-set size',independentSetPolynomial,sample]
];
export const HYPERGRAPHS_600=entries(defs,'CS','COMPUTER_SCIENCE',551);
