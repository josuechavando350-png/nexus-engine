import {obj,int,arr,result,entries} from './batch-600-common.mjs';
function state(x){const bits=arr(x,'state',1,10).map((v,i)=>int(v,`state[${i}]`,0,1));return bits;}
const number=x=>int(x,'rule',0,255);
const S=x=>{obj(x,['rule','state']);return {r:number(x.rule),s:state(x.state)};};
const W=x=>{obj(x,['rule','width']);return {r:number(x.rule),n:int(x.width,'width',1,10)};};
const T=x=>{obj(x,['rule','state','steps']);return {r:number(x.rule),s:state(x.state),steps:int(x.steps,'steps',0,256)};};
const encode=s=>s.reduce((v,b,i)=>v|(b<<i),0);
const decode=(v,n)=>Array.from({length:n},(_,i)=>v>>i&1);
const step=(rule,s,boundary='periodic')=>s.map((v,i)=>{
 const left=i===0?(boundary==='periodic'?s.at(-1):boundary==='mirror'?v:0):s[i-1];
 const right=i===s.length-1?(boundary==='periodic'?s[0]:boundary==='mirror'?v:0):s[i+1];
 return (rule>>((left<<2)|(v<<1)|right))&1;
});
const transition=(r,n)=>Array.from({length:1<<n},(_,v)=>encode(step(r,decode(v,n))));
const orbit=(trans,start)=>{const visited=new Map(),path=[];let v=start;while(!visited.has(v)){visited.set(v,path.length);path.push(v);v=trans[v];}return {path,preperiod:visited.get(v),period:path.length-visited.get(v)};};
const preimages=(trans,target)=>trans.flatMap((v,i)=>v===target?[i]:[]);
const reflected=r=>{let o=0;for(let pat=0;pat<8;pat++){const flipped=((pat&1)<<2)|(pat&2)|((pat&4)>>2);o|=((r>>flipped)&1)<<pat;}return o;};
const conjugated=r=>{let o=0;for(let pat=0;pat<8;pat++)o|=(1-((r>>(7-pat))&1))<<pat;return o;};
const xy=x=>{obj(x,['rule','width','target']);const r=number(x.rule),n=int(x.width,'width',1,10),target=state(x.target);if(target.length!==n)throw new RangeError('target length does not match width');return {r,n,target:encode(target)};};
export function periodicStep(x){const {r,s}=S(x);return result({state:step(r,s)});}
export function fixedZeroStep(x){const {r,s}=S(x);return result({state:step(r,s,'zero')});}
export function reflectiveStep(x){const {r,s}=S(x);return result({state:step(r,s,'mirror')});}
export function periodicTrace(x){const {r,s,steps}=T(x),trace=[s];for(let t=0;t<steps;t++)trace.push(step(r,trace.at(-1)));return result({trace});}
export function periodicFinal(x){const {r,s,steps}=T(x);let a=s;for(let t=0;t<steps;t++)a=step(r,a);return result({state:a});}
export function orbitStructure(x){const {r,s}=S(x),o=orbit(transition(r,s.length),encode(s));return result({preperiod:o.preperiod,period:o.period,states:o.path.map(v=>decode(v,s.length))});}
export function preimageCount(x){const {r,n,target}=xy(x);return result({count:preimages(transition(r,n),target).length});}
export function preimageList(x){const {r,n,target}=xy(x);return result({states:preimages(transition(r,n),target).map(v=>decode(v,n))});}
export function gardenOfEdenCount(x){const {r,n}=W(x),seen=new Set(transition(r,n));return result({count:(1<<n)-seen.size});}
export function gardenOfEdenStates(x){const {r,n}=W(x),seen=new Set(transition(r,n));return result({states:Array.from({length:1<<n},(_,i)=>i).filter(i=>!seen.has(i)).map(v=>decode(v,n))});}
export function imageSize(x){const {r,n}=W(x);return result({size:new Set(transition(r,n)).size});}
export function injectivity(x){const {r,n}=W(x);return result({injective:new Set(transition(r,n)).size===1<<n});}
export function surjectivity(x){const {r,n}=W(x);return result({surjective:new Set(transition(r,n)).size===1<<n});}
export function fixedStates(x){const {r,n}=W(x),tr=transition(r,n);return result({states:tr.flatMap((v,i)=>v===i?[decode(i,n)]:[])});}
export function fixedStateCount(x){const {r,n}=W(x),tr=transition(r,n);return result({count:tr.filter((v,i)=>v===i).length});}
export function exactTwoCycleStates(x){const {r,n}=W(x),tr=transition(r,n);return result({count:tr.filter((v,i)=>v!==i&&tr[v]===i).length});}
export function basinSizes(x){const {r,n}=W(x),tr=transition(r,n),m=new Map();for(let v=0;v<tr.length;v++){const o=orbit(tr,v),cycle=o.path.slice(o.preperiod),key=Math.min(...cycle);m.set(key,{cycleLength:cycle.length,basinSize:(m.get(key)?.basinSize??0)+1});}return result({basins:[...m].sort(([a],[b])=>a-b).map(([representative,v])=>({representative:decode(representative,n),...v}))});}
export function reachableTarget(x){obj(x,['rule','state','target']);const {r,s}=S({rule:x.rule,state:x.state}),target=state(x.target);if(target.length!==s.length)throw new RangeError('target size mismatch');const o=orbit(transition(r,s.length),encode(s));return result({reachable:o.path.includes(encode(target))});}
export function firstTargetTime(x){obj(x,['rule','state','target']);const {r,s}=S({rule:x.rule,state:x.state}),target=state(x.target);if(target.length!==s.length)throw new RangeError('target size mismatch');const o=orbit(transition(r,s.length),encode(s)),t=o.path.indexOf(encode(target));return result({time:t<0?null:t});}
export function densityTimeline(x){const {r,s,steps}=T(x),weights=[s.reduce((a,b)=>a+b,0)];let a=s;for(let t=0;t<steps;t++){a=step(r,a);weights.push(a.reduce((v,b)=>v+b,0));}return result({counts:weights});}
export function singleBitDamage(x){const {r,s}=S(x),base=step(r,s),distances=s.map((_,i)=>{const t=s.slice();t[i]^=1;return step(r,t).reduce((z,b,j)=>z+(b!==base[j]?1:0),0);});return result({distances});}
export function reflectRule(x){obj(x,['rule']);return result({rule:reflected(number(x.rule))});}
export function complementRule(x){obj(x,['rule']);return result({rule:conjugated(number(x.rule))});}
export function ruleSymmetryClass(x){obj(x,['rule']);const r=number(x.rule),c=conjugated(r);return result({rules:[...new Set([r,reflected(r),c,reflected(c)])].sort((a,b)=>a-b)});}
export function finiteNumberConservation(x){const {r,n}=W(x),tr=transition(r,n);return result({conserves:tr.every((v,i)=>decode(v,n).reduce((a,b)=>a+b,0)===decode(i,n).reduce((a,b)=>a+b,0))});}
const sample={rule:110,state:[1,0,1,1,0,0]},width={rule:110,width:6},target={rule:110,width:6,target:[1,0,1,1,0,0]};
const defs=[
 ['CA_PERIODIC_STEP','Elementary cellular automaton single periodic-boundary update',periodicStep,sample],
 ['CA_ZERO_BOUNDARY','Elementary cellular automaton update with zero boundary',fixedZeroStep,sample],
 ['CA_MIRROR_BOUNDARY','Elementary cellular automaton update with reflective boundary',reflectiveStep,sample],
 ['CA_SPACETIME_TRACE','Bounded periodic cellular-automaton space-time diagram',periodicTrace,{...sample,steps:12}],
 ['CA_FINAL_STATE','Periodic cellular automaton evolution after k steps',periodicFinal,{...sample,steps:32}],
 ['CA_ORBIT','Finite orbit preperiod and cycle length with states',orbitStructure,sample],
 ['CA_PREIMAGE_COUNT','Exact number of one-step predecessors of a target',preimageCount,target],
 ['CA_PREIMAGE_LIST','Complete enumeration of one-step target preimages',preimageList,target],
 ['CA_GARDEN_COUNT','Count one-step Garden-of-Eden configurations',gardenOfEdenCount,width],
 ['CA_GARDEN_STATES','Enumerate finite Garden-of-Eden configurations',gardenOfEdenStates,width],
 ['CA_IMAGE_SIZE','Cardinality of the periodic global update image',imageSize,width],
 ['CA_INJECTIVITY','Finite-width global update injectivity test',injectivity,width],
 ['CA_SURJECTIVITY','Finite-width global update surjectivity test',surjectivity,width],
 ['CA_FIXED_STATES','Enumerate all periodic fixed configurations',fixedStates,width],
 ['CA_FIXED_COUNT','Count all periodic fixed configurations',fixedStateCount,width],
 ['CA_EXACT_TWO_CYCLES','Count states of minimal period exactly two',exactTwoCycleStates,width],
 ['CA_BASINS','Exact cycle attractor lengths and basin sizes',basinSizes,width],
 ['CA_REACHABLE','Finite deterministic reachability of a target state',reachableTarget,{...sample,target:[0,1,0,1,1,0]}],
 ['CA_FIRST_HIT','Minimum time to hit a target or null',firstTargetTime,{...sample,target:[0,1,0,1,1,0]}],
 ['CA_DENSITY_TIMELINE','Number of active cells along a bounded evolution',densityTimeline,{...sample,steps:12}],
 ['CA_SINGLE_BIT_DAMAGE','One-step Hamming damage caused by flipping each cell',singleBitDamage,sample],
 ['CA_REFLECT_RULE','Left-right reflection of elementary cellular automaton rule',reflectRule,{rule:110}],
 ['CA_COMPLEMENT_RULE','Black-white conjugation of an elementary CA rule',complementRule,{rule:110}],
 ['CA_RULE_SYMMETRY','Complete reflection and black-white conjugacy class',ruleSymmetryClass,{rule:110}],
 ['CA_NUMBER_CONSERVATION','Exact finite-width periodic particle-number conservation',finiteNumberConservation,width]
];
export const CELLULAR_AUTOMATA_600=entries(defs,'PHYSICS','PHYSICS_COMPLEX_SYSTEMS',576);
