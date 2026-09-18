/* Independent oracle built from edge-vertex sets and brute subsets. */
import assert from 'node:assert/strict';
import {runBatchBank,seq} from './batch-238-common.mjs';
const tags=['HYPER_VERTEX_DEGREES','HYPER_EDGE_SIZE_HIST','HYPER_RANK','HYPER_COVERED_VERTICES','HYPER_COMMON_VERTICES','HYPER_MINIMAL_EDGES','HYPER_MAXIMAL_EDGES','HYPER_INCIDENCE_MATRIX','HYPER_PRIMAL_GRAPH','HYPER_INTERSECTION_GRAPH','HYPER_COMPONENTS','HYPER_ISOLATED','HYPER_INDEPENDENT_COUNT','HYPER_MAX_INDEPENDENT','HYPER_TRANSVERSAL_COUNT','HYPER_MIN_TRANSVERSAL','HYPER_MINIMAL_TRANSVERSALS','HYPER_MAX_EDGE_PACKING','HYPER_EDGE_PACKING_COUNT','HYPER_MIN_EDGE_COVER','HYPER_TWO_COLORABLE','HYPER_TWO_COLORINGS','HYPER_INDUCED','HYPER_DELETE_VERTEX','HYPER_INDEPENDENCE_POLY'];
const sub=a=>seq(2**a.length).map(m=>a.filter((_,i)=>m&(1<<i)));
const subset=(a,b)=>a.every(v=>b.includes(v)),disjoint=(a,b)=>a.every(v=>!b.includes(v)),lex=(a,b)=>{for(let i=0;i<Math.min(a.length,b.length);i++)if(a[i]!==b[i])return a[i]-b[i];return a.length-b.length;};
function input(tag,i,r){const n=1+i%5,verts=seq(n),all=sub(verts).filter(a=>a.length),edges=all.filter(()=>i%11===0?false:r(3)===0).slice(0,8).map(a=>r(2)?a.slice().reverse():a),h={vertexCount:n,edges};if(tag==='HYPER_INDUCED')return {hypergraph:h,vertices:verts.filter(()=>r(2))};if(tag==='HYPER_DELETE_VERTEX')return {hypergraph:h,vertex:r(n)};return h;}
function reference(tag,x){const h=x.hypergraph??x,n=h.vertexCount,v=seq(n),edges=h.edges.map(e=>e.slice().sort((a,b)=>a-b)).sort((a,b)=>a.reduce((s,t)=>s+2**t,0)-b.reduce((s,t)=>s+2**t,0)),vs=sub(v),es=sub(seq(edges.length));
 const hits=s=>edges.every(e=>!disjoint(e,s)),independent=s=>edges.every(e=>!subset(e,s)),packing=idx=>idx.every((u,i)=>idx.slice(i+1).every(w=>disjoint(edges[u],edges[w]))),covers=idx=>v.every(j=>idx.some(k=>edges[k].includes(j))),color=s=>edges.every(e=>!disjoint(e,s)&&!subset(e,s));
 const best=(ss,large=false)=>ss.slice().sort((a,b)=>(large?b.length-a.length:a.length-b.length)||lex(a,b))[0];
 const union=[...new Set(edges.flat())].sort((a,b)=>a-b),overlap=(a,b)=>!disjoint(a,b);
 switch(tag){
 case 'HYPER_VERTEX_DEGREES':return {degrees:v.map(j=>edges.filter(e=>e.includes(j)).length)};
 case 'HYPER_EDGE_SIZE_HIST':return {counts:seq(n+1).map(k=>edges.filter(e=>e.length===k).length)};
 case 'HYPER_RANK':return {rank:Math.max(0,...edges.map(e=>e.length))};
 case 'HYPER_COVERED_VERTICES':return {vertices:union};
 case 'HYPER_COMMON_VERTICES':return {vertices:edges.length?v.filter(j=>edges.every(e=>e.includes(j))):[]};
 case 'HYPER_MINIMAL_EDGES':return {edges:edges.filter(e=>!edges.some(f=>f!==e&&f.length<e.length&&subset(f,e)))};
 case 'HYPER_MAXIMAL_EDGES':return {edges:edges.filter(e=>!edges.some(f=>f!==e&&f.length>e.length&&subset(e,f)))};
 case 'HYPER_INCIDENCE_MATRIX':return {matrix:v.map(j=>edges.map(e=>Number(e.includes(j))))};
 case 'HYPER_PRIMAL_GRAPH':return {adjacency:v.map(i=>v.map(j=>Number(i!==j&&edges.some(e=>e.includes(i)&&e.includes(j)))))};
 case 'HYPER_INTERSECTION_GRAPH':return {edges:seq(edges.length).flatMap(i=>seq(edges.length).filter(j=>i<j&&overlap(edges[i],edges[j])).map(j=>[i,j]))};
 case 'HYPER_COMPONENTS':{const remaining=new Set(v),components=[];while(remaining.size){const s=Math.min(...remaining),component=new Set([s]);remaining.delete(s);let changed=true;while(changed){changed=false;for(const e of edges)if(e.some(t=>component.has(t)))for(const t of e)if(!component.has(t)){component.add(t);remaining.delete(t);changed=true;}}components.push([...component].sort((a,b)=>a-b));}return {components};}
 case 'HYPER_ISOLATED':return {vertices:v.filter(j=>!union.includes(j))};
 case 'HYPER_INDEPENDENT_COUNT':return {count:String(vs.filter(independent).length)};
 case 'HYPER_MAX_INDEPENDENT':{const b=best(vs.filter(independent),true);return {size:b.length,vertices:b};}
 case 'HYPER_TRANSVERSAL_COUNT':return {count:String(vs.filter(hits).length)};
 case 'HYPER_MIN_TRANSVERSAL':{const b=best(vs.filter(hits));return {size:b.length,vertices:b};}
 case 'HYPER_MINIMAL_TRANSVERSALS':return {sets:vs.filter(s=>hits(s)&&s.every(t=>!hits(s.filter(u=>u!==t))))};
 case 'HYPER_MAX_EDGE_PACKING':{const b=best(es.filter(packing),true);return {size:b.length,indices:b};}
 case 'HYPER_EDGE_PACKING_COUNT':return {count:String(es.filter(packing).length)};
 case 'HYPER_MIN_EDGE_COVER':{const b=best(es.filter(covers));return {indices:b??null,count:b?.length??null};}
 case 'HYPER_TWO_COLORABLE':{const b=vs.find(color);return {twoColorable:!!b,colorOne:b??null};}
 case 'HYPER_TWO_COLORINGS':return {count:String(vs.filter(color).length)};
 case 'HYPER_INDUCED':return {vertexCount:n,edges:edges.filter(e=>subset(e,x.vertices))};
 case 'HYPER_DELETE_VERTEX':return {vertexCount:n,edges:edges.filter(e=>!e.includes(x.vertex))};
 case 'HYPER_INDEPENDENCE_POLY':return {coefficients:seq(n+1).map(k=>String(vs.filter(s=>s.length===k&&independent(s)).length))};
 default:throw Error('missing hypergraph oracle '+tag);
 }
}
function verify(tag,x,actual,expected){if(['HYPER_MAX_INDEPENDENT','HYPER_MIN_TRANSVERSAL','HYPER_MAX_EDGE_PACKING','HYPER_MIN_EDGE_COVER','HYPER_TWO_COLORABLE'].includes(tag)){if(tag==='HYPER_TWO_COLORABLE'){assert.equal(actual.twoColorable,expected.twoColorable);if(actual.twoColorable){assert.ok(Array.isArray(actual.colorOne));assert.ok(x.edges.every(e=>e.some(v=>actual.colorOne.includes(v))&&e.some(v=>!actual.colorOne.includes(v))));}else assert.equal(actual.colorOne,null);return;}assert.deepStrictEqual(actual,expected);return;}assert.deepStrictEqual(actual,expected);}
export const runHypergraph438Bank=options=>runBatchBank({name:'AXIOMA bounded hypergraphs subset enumeration 551–575',prefix:'CS',start:551,tags,input,reference,verify,...options});
