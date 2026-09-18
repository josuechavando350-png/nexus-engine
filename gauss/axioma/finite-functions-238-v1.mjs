/* Oracle reconstructs functional digraphs by explicit vertex walks, without GAUSS algorithms. */
import {runBatchBank,seq} from './batch-238-common.mjs';
const tags=['FUNCTION_INDEGREES','FUNCTION_FIXED_POINTS','FUNCTION_FIXED_COUNT','FUNCTION_CYCLES','FUNCTION_CYCLE_COUNT','FUNCTION_CYCLIC_VERTICES','FUNCTION_TRANSIENT_VERTICES','FUNCTION_TRANSIENT_DEPTHS','FUNCTION_PERIOD_LENGTHS','FUNCTION_MAX_DEPTH','FUNCTION_ORBIT','FUNCTION_FIRST_HIT','FUNCTION_REACHABLE','FUNCTION_KTH_ITERATE','FUNCTION_IMAGE','FUNCTION_IMAGE_SIZE','FUNCTION_PREIMAGES','FUNCTION_COLLISION_PAIRS','FUNCTION_INJECTIVE','FUNCTION_SURJECTIVE','FUNCTION_IDEMPOTENT','FUNCTION_INVOLUTION','FUNCTION_COMPOSE','FUNCTION_POWER','FUNCTION_BASIN_SIZES'];
const input=(tag,i,r)=>{const n=1+i%12,f=seq(n).map(v=>i%11===0?v:i%11===1?0:i%11===2?(v+1)%n:i%11===3?Math.floor(v/2):r(n));
 if(tag==='FUNCTION_COMPOSE')return {left:f,right:seq(n).map(v=>i%4===0?v:r(n))};
 if(tag==='FUNCTION_POWER')return {mapping:f,exponent:i%5===0?0:i%5===1?1000000:r(10000)};
 if(['FUNCTION_FIRST_HIT','FUNCTION_REACHABLE'].includes(tag))return {mapping:f,source:r(n),target:r(n)};
 if(tag==='FUNCTION_KTH_ITERATE')return {mapping:f,vertex:r(n),steps:i%5===0?0:i%5===1?1000000:r(10000)};
 if(['FUNCTION_ORBIT','FUNCTION_PREIMAGES'].includes(tag))return {mapping:f,vertex:r(n)};
 return {mapping:f};};
function walk(f,s){const seen=new Map(),order=[];let v=s;while(!seen.has(v)){seen.set(v,order.length);order.push(v);v=f[v];}const preperiod=seen.get(v),cycle=order.slice(preperiod);return {walk:order,preperiod,period:cycle.length,cycle};}
function allCycles(f){const seen=new Set(),out=[];for(const v of seq(f.length)){const c=walk(f,v).cycle;if(c.every(k=>seen.has(k)))continue;const at=c.indexOf(Math.min(...c)),ordered=[...c.slice(at),...c.slice(0,at)];out.push(ordered);ordered.forEach(k=>seen.add(k));}return out.sort((a,b)=>a[0]-b[0]);}
const iterate=(f,v,k)=>{const w=walk(f,v);return k<w.walk.length?w.walk[k]:w.walk[w.preperiod+(k-w.preperiod)%w.period];};
function reference(tag,x){const f=x.mapping??x.left,n=f.length,vertices=seq(n),cycles=allCycles(f),cyclic=new Set(cycles.flat()),orbits=vertices.map(i=>walk(f,i));
 switch(tag){
 case 'FUNCTION_INDEGREES':return {degrees:vertices.map(v=>f.filter(w=>w===v).length)};
 case 'FUNCTION_FIXED_POINTS':return {vertices:vertices.filter(v=>f[v]===v)};
 case 'FUNCTION_FIXED_COUNT':return {count:vertices.filter(v=>f[v]===v).length};
 case 'FUNCTION_CYCLES':return {cycles};
 case 'FUNCTION_CYCLE_COUNT':return {count:cycles.length};
 case 'FUNCTION_CYCLIC_VERTICES':return {vertices:[...cyclic].sort((a,b)=>a-b)};
 case 'FUNCTION_TRANSIENT_VERTICES':return {vertices:vertices.filter(v=>!cyclic.has(v))};
 case 'FUNCTION_TRANSIENT_DEPTHS':return {distances:orbits.map(o=>o.preperiod)};
 case 'FUNCTION_PERIOD_LENGTHS':return {periods:orbits.map(o=>o.period)};
 case 'FUNCTION_MAX_DEPTH':return {depth:Math.max(...orbits.map(o=>o.preperiod))};
 case 'FUNCTION_ORBIT':return walk(f,x.vertex);
 case 'FUNCTION_FIRST_HIT':{const index=walk(f,x.source).walk.indexOf(x.target);return {time:index<0?null:index};}
 case 'FUNCTION_REACHABLE':return {reachable:walk(f,x.source).walk.includes(x.target)};
 case 'FUNCTION_KTH_ITERATE':return {vertex:iterate(f,x.vertex,x.steps)};
 case 'FUNCTION_IMAGE':return {vertices:[...new Set(f)].sort((a,b)=>a-b)};
 case 'FUNCTION_IMAGE_SIZE':return {size:new Set(f).size};
 case 'FUNCTION_PREIMAGES':return {vertices:vertices.filter(i=>f[i]===x.vertex)};
 case 'FUNCTION_COLLISION_PAIRS':return {pairs:vertices.flatMap(i=>vertices.filter(j=>j>i&&f[i]===f[j]).map(j=>[i,j]))};
 case 'FUNCTION_INJECTIVE':return {injective:new Set(f).size===n};
 case 'FUNCTION_SURJECTIVE':return {surjective:vertices.every(v=>f.includes(v))};
 case 'FUNCTION_IDEMPOTENT':return {idempotent:vertices.every(v=>f[f[v]]===f[v])};
 case 'FUNCTION_INVOLUTION':return {involution:vertices.every(v=>f[f[v]]===v)};
 case 'FUNCTION_COMPOSE':return {mapping:vertices.map(v=>x.left[x.right[v]])};
 case 'FUNCTION_POWER':return {mapping:vertices.map(v=>iterate(f,v,x.exponent))};
 case 'FUNCTION_BASIN_SIZES':{const groups=new Map();for(const v of vertices){const rep=Math.min(...orbits[v].cycle);groups.set(rep,(groups.get(rep)??0)+1);}return {basins:[...groups].sort((a,b)=>a[0]-b[0]).map(([representative,size])=>({representative,size}))};}
 default:throw Error(`no independent functional reference: ${tag}`);
 }
}
export const runFiniteFunction238Bank=options=>runBatchBank({name:'AXIOMA finite functions 751-775',prefix:'CS',start:751,tags,input,reference,...options});
