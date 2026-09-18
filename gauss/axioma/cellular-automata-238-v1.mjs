/* Independent elementary CA oracle: truth-table lookup, explicit binary configurations and orbit enumeration. */
import {runBatchBank,seq} from './batch-238-common.mjs';
const tags=['CA_PERIODIC_STEP','CA_ZERO_BOUNDARY','CA_MIRROR_BOUNDARY','CA_SPACETIME_TRACE','CA_FINAL_STATE','CA_ORBIT','CA_PREIMAGE_COUNT','CA_PREIMAGE_LIST','CA_GARDEN_COUNT','CA_GARDEN_STATES','CA_IMAGE_SIZE','CA_INJECTIVITY','CA_SURJECTIVITY','CA_FIXED_STATES','CA_FIXED_COUNT','CA_EXACT_TWO_CYCLES','CA_BASINS','CA_REACHABLE','CA_FIRST_HIT','CA_DENSITY_TIMELINE','CA_SINGLE_BIT_DAMAGE','CA_REFLECT_RULE','CA_COMPLEMENT_RULE','CA_RULE_SYMMETRY','CA_NUMBER_CONSERVATION'];
const widthTags=new Set(['CA_GARDEN_COUNT','CA_GARDEN_STATES','CA_IMAGE_SIZE','CA_INJECTIVITY','CA_SURJECTIVITY','CA_FIXED_STATES','CA_FIXED_COUNT','CA_EXACT_TWO_CYCLES','CA_BASINS','CA_NUMBER_CONSERVATION']);
const targetWidthTags=new Set(['CA_PREIMAGE_COUNT','CA_PREIMAGE_LIST']);
const stateTargetTags=new Set(['CA_REACHABLE','CA_FIRST_HIT']);
const stepTags=new Set(['CA_SPACETIME_TRACE','CA_FINAL_STATE','CA_DENSITY_TIMELINE']);
const ruleTags=new Set(['CA_REFLECT_RULE','CA_COMPLEMENT_RULE','CA_RULE_SYMMETRY']);
function input(tag,i,r){const rule=i%9===0?0:i%9===1?255:i%9===2?204:i%9===3?170:r(256),width=1+i%6,state=seq(width).map((_,k)=>i%7===0?0:i%7===1?1:r(2)),target=seq(width).map((_,k)=>i%5===0?state[k]:r(2));
 if(ruleTags.has(tag))return {rule};if(widthTags.has(tag))return {rule,width};if(targetWidthTags.has(tag))return {rule,width,target};if(stateTargetTags.has(tag))return {rule,state,target};if(stepTags.has(tag))return {rule,state,steps:i%7===0?0:i%7===1?128:r(80)};return {rule,state};}
const decode=(code,width)=>seq(width).map(i=>Math.floor(code/2**i)%2);
const encode=bits=>bits.reduce((sum,bit,i)=>sum+bit*2**i,0);
const table=rule=>rule.toString(2).padStart(8,'0').split('').reverse().map(Number);
function evolve(rule,state,boundary='periodic'){const t=table(rule),n=state.length;return state.map((v,i)=>{const left=i?state[i-1]:boundary==='periodic'?state[n-1]:boundary==='mirror'?v:0;const right=i+1<n?state[i+1]:boundary==='periodic'?state[0]:boundary==='mirror'?v:0;return t[left*4+v*2+right];});}
function allStates(width){return seq(2**width).map(i=>decode(i,width));}
function transition(rule,width){return allStates(width).map(state=>encode(evolve(rule,state)));}
function orbit(rule,state){const trans=transition(rule,state.length),visited=new Map(),states=[];let v=encode(state);while(!visited.has(v)){visited.set(v,states.length);states.push(v);v=trans[v];}const preperiod=visited.get(v);return {states:states.map(v=>decode(v,state.length)),preperiod,period:states.length-preperiod,cycle:states.slice(preperiod)};}
function reflect(rule){const t=table(rule);return encode(seq(8).map(k=>t[(k%2)*4+(Math.floor(k/2)%2)*2+Math.floor(k/4)]));}
function complement(rule){const t=table(rule);return encode(seq(8).map(k=>1-t[7-k]));}
function reference(tag,x){const rule=x.rule,width=x.width??x.state?.length,n=width??1,states=width?allStates(width):null,trans=width?transition(rule,width):null;
 switch(tag){
 case 'CA_PERIODIC_STEP':return {state:evolve(rule,x.state)};
 case 'CA_ZERO_BOUNDARY':return {state:evolve(rule,x.state,'zero')};
 case 'CA_MIRROR_BOUNDARY':return {state:evolve(rule,x.state,'mirror')};
 case 'CA_SPACETIME_TRACE':{const trace=[x.state];for(let k=0;k<x.steps;k++)trace.push(evolve(rule,trace.at(-1)));return {trace};}
 case 'CA_FINAL_STATE':{let v=x.state;for(let k=0;k<x.steps;k++)v=evolve(rule,v);return {state:v};}
 case 'CA_ORBIT':{const o=orbit(rule,x.state);return {preperiod:o.preperiod,period:o.period,states:o.states};}
 case 'CA_PREIMAGE_COUNT':return {count:trans.filter(v=>v===encode(x.target)).length};
 case 'CA_PREIMAGE_LIST':return {states:states.filter((v,i)=>trans[i]===encode(x.target))};
 case 'CA_GARDEN_COUNT':return {count:states.length-new Set(trans).size};
 case 'CA_GARDEN_STATES':return {states:states.filter((_,i)=>!trans.includes(i))};
 case 'CA_IMAGE_SIZE':return {size:new Set(trans).size};
 case 'CA_INJECTIVITY':return {injective:new Set(trans).size===states.length};
 case 'CA_SURJECTIVITY':return {surjective:seq(states.length).every(v=>trans.includes(v))};
 case 'CA_FIXED_STATES':return {states:states.filter((v,i)=>trans[i]===i)};
 case 'CA_FIXED_COUNT':return {count:seq(trans.length).filter(i=>trans[i]===i).length};
 case 'CA_EXACT_TWO_CYCLES':return {count:seq(trans.length).filter(i=>trans[i]!==i&&trans[trans[i]]===i).length};
 case 'CA_BASINS':{const by=new Map();for(const s of states){const c=orbit(rule,s).cycle,rep=Math.min(...c);if(!by.has(rep))by.set(rep,{cycleLength:c.length,basinSize:0});by.get(rep).basinSize++;}return {basins:[...by].sort((a,b)=>a[0]-b[0]).map(([representative,v])=>({representative:decode(representative,width),...v}))};}
 case 'CA_REACHABLE':return {reachable:orbit(rule,x.state).states.some(s=>encode(s)===encode(x.target))};
 case 'CA_FIRST_HIT':{const index=orbit(rule,x.state).states.findIndex(s=>encode(s)===encode(x.target));return {time:index<0?null:index};}
 case 'CA_DENSITY_TIMELINE':{const counts=[x.state.filter(Boolean).length];let state=x.state;for(let k=0;k<x.steps;k++){state=evolve(rule,state);counts.push(state.filter(Boolean).length);}return {counts};}
 case 'CA_SINGLE_BIT_DAMAGE':{const baseline=evolve(rule,x.state);return {distances:seq(x.state.length).map(i=>{const changed=x.state.slice();changed[i]=1-changed[i];const out=evolve(rule,changed);return out.filter((v,j)=>v!==baseline[j]).length;})};}
 case 'CA_REFLECT_RULE':return {rule:reflect(rule)};
 case 'CA_COMPLEMENT_RULE':return {rule:complement(rule)};
 case 'CA_RULE_SYMMETRY':{const c=complement(rule);return {rules:[...new Set([rule,reflect(rule),c,reflect(c)])].sort((a,b)=>a-b)};}
 case 'CA_NUMBER_CONSERVATION':return {conserves:states.every((s,i)=>s.filter(Boolean).length===decode(trans[i],width).filter(Boolean).length)};
 default:throw Error(`missing independent cellular reference ${tag}`);
 }
}
export const runCellular238Bank=options=>runBatchBank({name:'AXIOMA elementary cellular automata 576-600',prefix:'PHYSICS',start:576,tags,input,reference,...options});
