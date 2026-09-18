/* Independent weighted tree oracles: exhaustive simple paths and connectivity by edge filtering. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GAUSS_IMPLEMENTED_LAYERS,getGaussLayer} from '../core/registry.mjs';
const TAGS=['EDGE_SUM','EDGE_MIN','EDGE_MAX','EDGE_SORT','ROOT_DISTANCES','PAIR_DISTANCE','DISTANCE_MATRIX','ECCENTRICITIES','RADIUS','CENTERS','DIAMETER','DIAMETER_WITNESS','WIENER_INDEX','PAIR_MEAN','FARNESS','MEDIAN','ROOT_LEAF_DISTANCES','ROOT_LEAF_MIN','ROOT_LEAF_MAX','PATH_WEIGHTS','PATH_MAX','PATH_MIN','PATH_PRODUCT','THRESHOLD_COMPONENTS','THRESHOLD_PAIRS'];
const id=(tag,i)=>`GAUSS.CS.WEIGHTED_TREES.${tag}.${901+i}`;
const vertices=n=>Array.from({length:n},(_,i)=>i);
function path(t,a,b){const adj=vertices(t.n).map(()=>[]);for(const[u,v,w]of t.edges){adj[u].push([v,w]);adj[v].push([u,w]);}function visit(v,seen,weights){if(v===b)return weights;for(const [next,w] of adj[v])if(!seen.has(next)){const result=visit(next,new Set([...seen,next]),[...weights,w]);if(result!==null)return result;}return null;}return visit(a,new Set([a]),[]);}
const metric=t=>vertices(t.n).map(a=>vertices(t.n).map(b=>path(t,a,b).reduce((s,w)=>s+BigInt(w),0n)));
const max=xs=>xs.reduce((a,b)=>a>b?a:b,0n);
const min=xs=>xs.reduce((a,b)=>a<b?a:b);
const fmt=xs=>xs.map(String);
function gcd(a,b){while(b)[a,b]=[b,a%b];return a;}
function components(t,threshold){const adj=vertices(t.n).map(()=>[]);for(const[u,v,w]of t.edges)if(w<=threshold){adj[u].push(v);adj[v].push(u);}const seen=new Set(),groups=[];for(const start of vertices(t.n)){if(seen.has(start))continue;const stack=[start],group=[];seen.add(start);while(stack.length){const v=stack.pop();group.push(v);for(const w of adj[v])if(!seen.has(w)){seen.add(w);stack.push(w);}}groups.push(group.sort((a,b)=>a-b));}return groups.sort((a,b)=>a[0]-b[0]);}
function reference(tag,input){const t=input.tree??input,n=t.n,edges=t.edges,V=vertices(n),d=metric(t),ecc=d.map(max),sums=d.map(row=>row.reduce((a,b)=>a+b,0n)),radius=min(ecc),degrees=V.map(v=>edges.filter(([a,b])=>a===v||b===v).length),leaves=V.filter(v=>n===1||v!==t.root&&degrees[v]===1),leafValues=leaves.map(v=>d[t.root][v]),pathWeights=tag.startsWith('PATH_')?path(t,input.a,input.b):[],pairs=V.flatMap(i=>V.filter(j=>j>i).map(j=>[i,j]));
 switch(tag){
 case 'EDGE_SUM':return {weight:String(edges.reduce((s,e)=>s+BigInt(e[2]),0n))};
 case 'EDGE_MIN':return {weight:edges.length?Math.min(...edges.map(e=>e[2])):null};
 case 'EDGE_MAX':return {weight:edges.length?Math.max(...edges.map(e=>e[2])):null};
 case 'EDGE_SORT':return {edges:edges.map(([a,b,w])=>[Math.min(a,b),Math.max(a,b),w]).sort((a,b)=>a[2]-b[2]||a[0]-b[0]||a[1]-b[1])};
 case 'ROOT_DISTANCES':return {distances:fmt(d[t.root])};
 case 'PAIR_DISTANCE':return {distance:String(d[input.a][input.b])};
 case 'DISTANCE_MATRIX':return {distances:d.map(fmt)};
 case 'ECCENTRICITIES':return {eccentricities:fmt(ecc)};
 case 'RADIUS':return {radius:String(radius)};
 case 'CENTERS':return {vertices:V.filter(i=>ecc[i]===radius)};
 case 'DIAMETER':return {diameter:String(max(ecc))};
 case 'DIAMETER_WITNESS':{let best=null,value=-1n;for(const [i,j]of pairs)if(d[i][j]>value){best=[i,j];value=d[i][j];}return {vertices:best,diameter:String(value<0n?0n:value)};}
 case 'WIENER_INDEX':return {index:String(pairs.reduce((s,[i,j])=>s+d[i][j],0n))};
 case 'PAIR_MEAN':{if(!pairs.length)return {mean:null};const total=pairs.reduce((s,[i,j])=>s+d[i][j],0n),den=BigInt(pairs.length),g=gcd(total,den);return {mean:`${total/g}/${den/g}`};}
 case 'FARNESS':return {sums:fmt(sums)};
 case 'MEDIAN':return {vertices:V.filter(i=>sums[i]===min(sums))};
 case 'ROOT_LEAF_DISTANCES':return {leaves:leaves.map(v=>({vertex:v,distance:String(d[t.root][v])}))};
 case 'ROOT_LEAF_MIN':return {distance:String(min(leafValues))};
 case 'ROOT_LEAF_MAX':return {distance:String(max(leafValues))};
 case 'PATH_WEIGHTS':return {weights:pathWeights};
 case 'PATH_MAX':return {weight:pathWeights.length?Math.max(...pathWeights):null};
 case 'PATH_MIN':return {weight:pathWeights.length?Math.min(...pathWeights):null};
 case 'PATH_PRODUCT':return {product:String(pathWeights.reduce((s,w)=>s*BigInt(w),1n))};
 case 'THRESHOLD_COMPONENTS':return {components:components(t,input.threshold)};
 case 'THRESHOLD_PAIRS':return {pairs:String(components(t,input.threshold).reduce((s,g)=>s+BigInt(g.length*(g.length-1)/2),0n))};
 default:throw Error('unknown weighted-tree reference '+tag);
 }
}
function rng(seed){let state=seed>>>0;return max=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)%max;};}
function inputFor(tag,i,r){const n=i%19===0?1:2+r(7),edges=[];for(let v=1;v<n;v++)edges.push([r(v),v,r(11)]);const tree={n,root:r(n),edges};
 if(['PAIR_DISTANCE','PATH_WEIGHTS','PATH_MAX','PATH_MIN','PATH_PRODUCT'].includes(tag))return {tree,a:r(n),b:r(n)};
 if(['THRESHOLD_COMPONENTS','THRESHOLD_PAIRS'].includes(tag))return {tree,threshold:r(12)};
 return tree;
}
export function runWeightedTreeBank({resolveLayer=getGaussLayer}={}){
 assert.equal(GAUSS_IMPLEMENTED_LAYERS.length,1000);
 const report={schemaVersion:1,subject:'GAUSS exact weighted tree metrics',seed:'0x715ee77a',oracle:'independent exhaustive unique paths, all-pairs sums, threshold edge-deletion DFS',registryOperators:1000,coveredOperators:0,validCases:0,passedValidCases:0,failedValidCases:0,invalidCases:0,passedInvalidRejections:0,failedInvalidRejections:0,operatorResults:[],failures:[],caseDigest:''};
 const hash=createHash('sha256');
 for(const [index,tag]of TAGS.entries()){
 const layerId=id(tag,index),layer=resolveLayer(layerId);assert.equal(typeof layer?.execute,'function',`missing ${layerId}`);
 const r=rng(Number.parseInt(createHash('sha256').update(layerId).digest('hex').slice(0,8),16)^0x715ee77a),item={id:layerId,validCases:0,passed:0,failed:0,invalidCases:0,rejected:0,invalidAccepted:0};
 for(let j=0;j<100;j++){
 const input=inputFor(tag,j,r),expected=reference(tag,input);hash.update(JSON.stringify({id:layerId,j,input,expected}));item.validCases++;report.validCases++;let actual;
 try{actual=layer.execute(structuredClone(input));assert.deepStrictEqual(actual,expected);item.passed++;report.passedValidCases++;}
 catch(error){item.failed++;report.failedValidCases++;if(report.failures.length<20)report.failures.push({id:layerId,j,input,expected,actual:actual??null,reason:String(error)});}
 if(j===0){const nested='tree'in input,base=nested?input.tree:input;const invalid=[{...input,extra:1},nested?{...input,tree:{...base,n:25}}:{...base,n:25},nested?{...input,tree:{...base,edges:[[0,0,1],...base.edges]}}:{...base,edges:[[0,0,1],...base.edges]}];
 for(const [k,v]of invalid.entries()){item.invalidCases++;report.invalidCases++;try{const out=layer.execute(structuredClone(v));item.invalidAccepted++;report.failedInvalidRejections++;if(report.failures.length<20)report.failures.push({id:layerId,j:`invalid-${k}`,input:v,actual:out,reason:'invalid accepted'});}catch{item.rejected++;report.passedInvalidRejections++;}}
 }
 }
 report.coveredOperators++;report.operatorResults.push(item);
 }
 report.untestedOperators=1000-report.coveredOperators;report.caseDigest=`sha256:${hash.digest('hex')}`;report.validPassRate=report.passedValidCases/report.validCases;report.invalidRejectionRate=report.passedInvalidRejections/report.invalidCases;return report;
}
