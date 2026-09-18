/* Independent exhaustive reference checks for twelve finite-graph operators. No GAUSS graph algorithms or expected fixtures are imported. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GAUSS_IMPLEMENTED_LAYERS, getGaussLayer} from '../core/registry.mjs';
const CASES=100, SEED=0x28a116c;
const ID=name=>`GAUSS.CS.${name}`;
function rng(seed){let s=seed>>>0;return max=>{s^=s<<13;s^=s>>>17;s^=s<<5;return(s>>>0)%max;};}
function graph(i,r,directed=false){const vertexCount=(directed?2:1)+r(directed?4:5),edges=[];for(let a=0;a<vertexCount;a++)for(let b=0;b<vertexCount;b++)if(a!==b&&(directed||a<b)&&r(4)<2)edges.push({from:a,to:b});return{vertexCount,edges};}
const adjacent=(g,a,b,directed=false)=>g.edges.some(e=>e.from===a&&e.to===b||!directed&&e.from===b&&e.to===a);
function permutations(values,visit){const out=[],used=new Set();function step(){if(out.length===values.length){visit(out.slice());return;}for(const v of values)if(!used.has(v)){used.add(v);out.push(v);step();out.pop();used.delete(v);}}step();}
const vertices=g=>Array.from({length:g.vertexCount},(_,i)=>i);
function subsets(items,visit){for(let mask=0;mask<2**items.length;mask++)visit(items.filter((_,i)=>mask&2**i));}
function components(g){const parent=vertices(g);function root(v){while(parent[v]!==v)v=parent[v];return v;}for(const e of g.edges)parent[root(e.from)]=root(e.to);const groups=new Map();for(const v of vertices(g)){const key=root(v);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(v);}const cs=[...groups.values()];cs.sort((a,b)=>a[0]-b[0]);return{components:cs,count:cs.length};}
function bipartite(g){for(let mask=0;mask<2**g.vertexCount;mask++){const colors=vertices(g).map(v=>(mask>>v)&1);if(g.edges.every(e=>colors[e.from]!==colors[e.to]))return{bipartite:true};}return{bipartite:false};}
function spanningTrees(g){let count=0n;subsets(g.edges,es=>{if(es.length!==g.vertexCount-1)return;if(components({...g,edges:es}).count===1)count++;});return{spanningTrees:count.toString()};}
function topo(g){let count=0n;permutations(vertices(g),order=>{const place=Array(g.vertexCount);order.forEach((v,i)=>{place[v]=i;});if(g.edges.every(e=>place[e.from]<place[e.to]))count++;});return{topologicalOrders:count.toString(),acyclic:count>0n};}
function cliqueSize(g){let best=0;subsets(vertices(g),group=>{if(group.length<=best)return;if(group.every((v,i)=>group.slice(i+1).every(w=>adjacent(g,v,w))))best=group.length;});return best;}
function dominatingSize(g){let best=g.vertexCount+1;subsets(vertices(g),group=>{if(group.length>=best)return;if(vertices(g).every(v=>group.some(w=>w===v||adjacent(g,v,w))))best=group.length;});return best;}
function colorings(g){let count=0n;const colors=Array(g.vertexCount).fill(0);function assign(v){if(v===g.vertexCount){if(g.edges.every(e=>colors[e.from]!==colors[e.to]))count++;return;}for(let c=0;c<g.colors;c++){colors[v]=c;assign(v+1);}}assign(0);return{colorings:count.toString()};}
function hamilton(g){let exists=false;permutations(vertices(g),p=>{if(p.slice(1).every((v,i)=>adjacent(g,p[i],v)))exists=true;});return{exists};}
function simplePaths(g){let count=0n;function visit(v,seen){if(v===g.target){count++;return;}for(const w of vertices(g))if(!seen.has(w)&&adjacent(g,v,w,true)){seen.add(w);visit(w,seen);seen.delete(w);}}visit(g.source,new Set([g.source]));return{simplePaths:count.toString()};}
function walks(g){let count=0n;function visit(v,k){if(!k){if(v===g.target)count++;return;}for(const w of vertices(g))if(adjacent(g,v,w,true))visit(w,k-1);}visit(g.source,g.length);return{walks:count.toString(),length:g.length};}
function matchingSize(g){let best=0;subsets(g.edges,es=>{if(es.length<=best)return;const ends=es.flatMap(e=>[e.from,e.to]);if(new Set(ends).size===ends.length)best=es.length;});return best;}
function girth(g){let best=Infinity;for(let k=3;k<=g.vertexCount;k++)subsets(vertices(g),vs=>{if(vs.length!==k)return;permutations(vs,p=>{if(p.every((v,i)=>adjacent(g,v,p[(i+1)%p.length])))best=Math.min(best,k);});});return{girth:Number.isFinite(best)?best:null,acyclic:!Number.isFinite(best)};}
function validWitness(g,actual,field,size,condition){assert.deepStrictEqual(Object.keys(actual).sort(),[field,'size'].sort());assert.equal(actual.size,size);const selected=actual[field];assert.ok(Array.isArray(selected));assert.equal(selected.length,size);assert.deepStrictEqual(selected.slice().sort((a,b)=>a-b),selected);assert.equal(new Set(selected).size,size);assert.ok(selected.every(v=>Number.isInteger(v)&&v>=0&&v<g.vertexCount));assert.ok(condition(selected));}
function checkBipartite(g,expected,actual){assert.deepStrictEqual(Object.keys(actual).sort(),['bipartite','colors']);assert.equal(actual.bipartite,expected.bipartite);if(!expected.bipartite){assert.equal(actual.colors,null);return;}assert.ok(Array.isArray(actual.colors));assert.equal(actual.colors.length,g.vertexCount);assert.ok(actual.colors.every(c=>c===0||c===1));assert.ok(g.edges.every(e=>actual.colors[e.from]!==actual.colors[e.to]));}
function checkHamilton(g,expected,actual){assert.deepStrictEqual(Object.keys(actual).sort(),['exists','path']);assert.equal(actual.exists,expected.exists);if(!expected.exists){assert.equal(actual.path,null);return;}assert.ok(Array.isArray(actual.path));assert.equal(actual.path.length,g.vertexCount);assert.equal(new Set(actual.path).size,g.vertexCount);assert.ok(actual.path.every(v=>Number.isInteger(v)&&v>=0&&v<g.vertexCount));assert.ok(actual.path.slice(1).every((v,i)=>adjacent(g,actual.path[i],v)));}
function checkMatching(g,expected,actual){assert.deepStrictEqual(Object.keys(actual).sort(),['cardinality','edges']);assert.equal(actual.cardinality,expected.cardinality);assert.ok(Array.isArray(actual.edges));assert.equal(actual.edges.length,expected.cardinality);const ends=[];for(const e of actual.edges){assert.ok(Array.isArray(e)&&e.length===2);assert.ok(adjacent(g,e[0],e[1]));ends.push(...e);}assert.equal(new Set(ends).size,ends.length);}
const directed=(i,r)=>graph(i,r,true);
const withTerminals=(i,r)=>{const g=directed(i,r);return{...g,source:0,target:g.vertexCount-1};};
const definitions=[
  {id:ID('UNDIRECTED_COMPONENTS.019'),make:graph,reference:components},
  {id:ID('BIPARTITE_COLORING.020'),make:graph,reference:bipartite,verify:checkBipartite},
  {id:ID('SPANNING_TREE_COUNT.021'),make:graph,reference:spanningTrees},
  {id:ID('TOPOLOGICAL_ORDER_COUNT.022'),make:directed,reference:topo},
  {id:ID('MAX_CLIQUE_EXACT.023'),make:graph,reference:g=>({size:cliqueSize(g)}),verify:(g,e,a)=>validWitness(g,a,'vertices',e.size,vs=>vs.every((v,i)=>vs.slice(i+1).every(w=>adjacent(g,v,w))))},
  {id:ID('MIN_DOMINATING_SET.024'),make:graph,reference:g=>({size:dominatingSize(g)}),verify:(g,e,a)=>validWitness(g,a,'vertices',e.size,vs=>vertices(g).every(v=>vs.some(w=>w===v||adjacent(g,v,w))))},
  {id:ID('PROPER_COLORING_COUNT.025'),make:(i,r)=>({...graph(i,r),colors:1+r(3)}),reference:colorings},
  {id:ID('HAMILTONIAN_PATH_EXACT.026'),make:graph,reference:hamilton,verify:checkHamilton},
  {id:ID('DIRECTED_SIMPLE_PATH_COUNT.027'),make:withTerminals,reference:simplePaths},
  {id:ID('DIRECTED_WALK_COUNT.028'),make:(i,r)=>({...withTerminals(i,r),length:r(5)}),reference:walks},
  {id:ID('GENERAL_MATCHING_EXACT.029'),make:graph,reference:g=>({cardinality:matchingSize(g)}),verify:checkMatching},
  {id:ID('GRAPH_GIRTH.030'),make:graph,reference:girth},
];
export function runFiniteGraphBank({resolveLayer=getGaussLayer}={}){
 assert.equal(GAUSS_IMPLEMENTED_LAYERS.length,1000);assert.equal(new Set(definitions.map(x=>x.id)).size,definitions.length);
 const report={schemaVersion:1,subject:'GAUSS bounded exact finite graphs',seed:`0x${SEED.toString(16)}`,oracle:'independent direct enumeration of vertex permutations, edge subsets, colors, paths and cycles',registryOperators:1000,coveredOperators:0,validCases:0,passedValidCases:0,failedValidCases:0,invalidCases:0,passedInvalidRejections:0,failedInvalidRejections:0,operatorResults:[],failures:[],caseDigest:''};
 const hash=createHash('sha256');
 for(const definition of definitions){const layer=resolveLayer(definition.id);assert.equal(typeof layer?.execute,'function',`missing GAUSS operator ${definition.id}`);const r=rng(Number.parseInt(createHash('sha256').update(definition.id).digest('hex').slice(0,8),16)^SEED);const item={id:definition.id,validCases:0,passed:0,failed:0,invalidCases:0,rejected:0,invalidAccepted:0};
  for(let index=0;index<CASES;index++){
   const input=definition.make(index,r),expected=definition.reference(input);hash.update(JSON.stringify({id:definition.id,index,input,expected}));item.validCases++;report.validCases++;let actual;
   try{actual=layer.execute(structuredClone(input));if(definition.verify)definition.verify(input,expected,actual);else assert.deepStrictEqual(actual,expected);item.passed++;report.passedValidCases++;}
   catch(error){item.failed++;report.failedValidCases++;if(report.failures.length<20)report.failures.push({id:definition.id,index,input,expected,actual:actual??null,reason:String(error)});}
   if(index===0){const invalid=[{...input,vertexCount:0},{...input,edges:[{from:0,to:0}]},{...input,edges:[{from:0,to:999}]}];for(const [invalidIndex,bad] of invalid.entries()){item.invalidCases++;report.invalidCases++;try{const output=layer.execute(structuredClone(bad));item.invalidAccepted++;report.failedInvalidRejections++;if(report.failures.length<20)report.failures.push({id:definition.id,index:`invalid-${invalidIndex}`,input:bad,expected:'rejection',actual:output,reason:'invalid graph accepted'});}catch{item.rejected++;report.passedInvalidRejections++;}}}
  }
  report.coveredOperators++;report.operatorResults.push(item);
 }
 report.untestedOperators=1000-report.coveredOperators;report.caseDigest=`sha256:${hash.digest('hex')}`;report.validPassRate=report.passedValidCases/report.validCases;report.invalidRejectionRate=report.passedInvalidRejections/report.invalidCases;return report;
}
