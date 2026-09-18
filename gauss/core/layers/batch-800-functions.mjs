import {record,integer,array,output,entries,range} from './batch-800-common.mjs';
function T(x){record(x,['mapping']);const a=array(x.mapping,'mapping',1,32),n=a.length;return a.map((v,i)=>integer(v,`mapping[${i}]`,0,n-1));}
const at=x=>{record(x,['mapping','vertex']);const f=T({mapping:x.mapping});return [f,integer(x.vertex,'vertex',0,f.length-1)];};
const pair=x=>{record(x,['mapping','source','target']);const f=T({mapping:x.mapping});return [f,integer(x.source,'source',0,f.length-1),integer(x.target,'target',0,f.length-1)];};
function orb(f,v){const seen=new Map(),walk=[];while(!seen.has(v)){seen.set(v,walk.length);walk.push(v);v=f[v];}return {walk,preperiod:seen.get(v),period:walk.length-seen.get(v),cycle:walk.slice(seen.get(v))};}
function cycles(f){const seen=new Set(),r=[];for(const i of range(f.length)){if(seen.has(i))continue;const o=orb(f,i);o.walk.forEach(v=>seen.add(v));const c=o.cycle,min=Math.min(...c),k=c.indexOf(min);if(!r.some(v=>v.includes(min)))r.push([...c.slice(k),...c.slice(0,k)]);}return r.sort((a,b)=>a[0]-b[0]);}
function trans(f){return range(f.length).map(i=>orb(f,i));}
export function fnIndegrees(x){const f=T(x),d=Array(f.length).fill(0);f.forEach(v=>d[v]++);return output({degrees:d});}
export function fnFixedPoints(x){const f=T(x);return output({vertices:range(f.length).filter(i=>f[i]===i)});}
export function fnFixedCount(x){const f=T(x);return output({count:f.filter((v,i)=>v===i).length});}
export function fnCycles(x){return output({cycles:cycles(T(x))});}
export function fnCycleCount(x){return output({count:cycles(T(x)).length});}
export function fnCyclicVertices(x){return output({vertices:cycles(T(x)).flat().sort((a,b)=>a-b)});}
export function fnTransientVertices(x){const f=T(x),on=new Set(cycles(f).flat());return output({vertices:range(f.length).filter(v=>!on.has(v))});}
export function fnDistanceToCycle(x){const f=T(x);return output({distances:trans(f).map(v=>v.preperiod)});}
export function fnPeriodLengths(x){const f=T(x);return output({periods:trans(f).map(v=>v.period)});}
export function fnMaxTransientDepth(x){const f=T(x);return output({depth:Math.max(...trans(f).map(o=>o.preperiod))});}
export function fnOrbit(x){const [f,v]=at(x),o=orb(f,v);return output(o);}
export function fnFirstHit(x){const [f,s,t]=pair(x),o=orb(f,s);const k=o.walk.indexOf(t);return output({time:k===-1?null:k});}
export function fnReachable(x){const [f,s,t]=pair(x);return output({reachable:orb(f,s).walk.includes(t)});}
export function fnKthIterate(x){record(x,['mapping','vertex','steps']);const [f,v]=at({mapping:x.mapping,vertex:x.vertex}),k=integer(x.steps,'steps',0,1000000),o=orb(f,v);return output({vertex:k<o.walk.length?o.walk[k]:o.walk[o.preperiod+(k-o.preperiod)%o.period]});}
export function fnImage(x){return output({vertices:[...new Set(T(x))].sort((a,b)=>a-b)});}
export function fnImageSize(x){return output({size:new Set(T(x)).size});}
export function fnPreimages(x){const [f,v]=at(x);return output({vertices:range(f.length).filter(i=>f[i]===v)});}
export function fnCollisionPairs(x){const f=T(x),pairs=[];for(let i=0;i<f.length;i++)for(let j=i+1;j<f.length;j++)if(f[i]===f[j])pairs.push([i,j]);return output({pairs});}
export function fnInjective(x){const f=T(x);return output({injective:new Set(f).size===f.length});}
export function fnSurjective(x){const f=T(x);return output({surjective:new Set(f).size===f.length});}
export function fnIdempotent(x){const f=T(x);return output({idempotent:f.every(v=>f[v]===v)});}
export function fnInvolution(x){const f=T(x);return output({involution:f.every((v,i)=>f[v]===i)});}
export function fnComposition(x){record(x,['left','right']);const f=T({mapping:x.left}),g=T({mapping:x.right});if(f.length!==g.length)throw new RangeError('domain size mismatch');return output({mapping:g.map(v=>f[v])});}
export function fnPower(x){record(x,['mapping','exponent']);let f=T({mapping:x.mapping}),k=integer(x.exponent,'exponent',0,1000000),r=range(f.length);while(k){if(k%2)r=r.map(v=>f[v]);k=Math.floor(k/2);if(k)f=f.map(v=>f[v]);}return output({mapping:r});}
export function fnBasins(x){const f=T(x),m=new Map();for(let i=0;i<f.length;i++){const c=orb(f,i).cycle,r=Math.min(...c);m.set(r,(m.get(r)||0)+1);}return output({basins:[...m].sort((a,b)=>a[0]-b[0]).map(([representative,size])=>({representative,size}))});}
const s={mapping:[1,2,0,4,5,4,6,5]},v={...s,vertex:3},p={...s,source:7,target:4};
const specs=[['FUNCTION_INDEGREES','In-degree histogram of a finite endofunction',fnIndegrees,s],['FUNCTION_FIXED_POINTS','Fixed-point vertices of endofunction',fnFixedPoints,s],['FUNCTION_FIXED_COUNT','Exact number of fixed points',fnFixedCount,s],['FUNCTION_CYCLES','Canonical directed cycle decomposition',fnCycles,s],['FUNCTION_CYCLE_COUNT','Number of endofunction cycles',fnCycleCount,s],['FUNCTION_CYCLIC_VERTICES','Vertices lying on a directed function cycle',fnCyclicVertices,s],['FUNCTION_TRANSIENT_VERTICES','Vertices outside all cycles',fnTransientVertices,s],['FUNCTION_TRANSIENT_DEPTHS','Steps to eventual cycle for each vertex',fnDistanceToCycle,s],['FUNCTION_PERIOD_LENGTHS','Eventual orbit period for every vertex',fnPeriodLengths,s],['FUNCTION_MAX_DEPTH','Maximum transient depth in functional graph',fnMaxTransientDepth,s],['FUNCTION_ORBIT','Explicit orbit with preperiod and cycle',fnOrbit,v],['FUNCTION_FIRST_HIT','Earliest nonnegative target-hitting iterate',fnFirstHit,p],['FUNCTION_REACHABLE','Reachability along deterministic iterates',fnReachable,p],['FUNCTION_KTH_ITERATE','Fast million-step bounded endofunction iterate',fnKthIterate,{...v,steps:999999}],['FUNCTION_IMAGE','Sorted image set of finite function',fnImage,s],['FUNCTION_IMAGE_SIZE','Image cardinality of finite function',fnImageSize,s],['FUNCTION_PREIMAGES','Complete direct preimage of target vertex',fnPreimages,v],['FUNCTION_COLLISION_PAIRS','All unordered domain collisions with equal mapped value',fnCollisionPairs,s],['FUNCTION_INJECTIVE','Injectivity test of finite function',fnInjective,s],['FUNCTION_SURJECTIVE','Surjectivity test of finite function',fnSurjective,s],['FUNCTION_IDEMPOTENT','Check functional idempotence f squared equals f',fnIdempotent,s],['FUNCTION_INVOLUTION','Check involutory function f squared equals identity',fnInvolution,s],['FUNCTION_COMPOSE','Compose two total bounded endofunctions',fnComposition,{left:s.mapping,right:[0,0,1,2,3,4,5,6]}],['FUNCTION_POWER','Exponentiate functional mapping by squaring',fnPower,{...s,exponent:12345}],['FUNCTION_BASIN_SIZES','Basins of attraction by canonical cycle representative',fnBasins,s]];
export const FINITE_FUNCTIONS_800=entries(specs,'CS','COMPUTER_SCIENCE',751);
