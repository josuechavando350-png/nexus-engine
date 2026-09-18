/* Independent exact Markov oracle: enumerate full weighted paths, not GAUSS transition powers. */
import {runFinalBank,range} from './final-common-v1.mjs';
const tags=['STEP_DISTRIBUTION','TRANSITION_POWER','RETURN_PROBABILITY','OCCUPANCY','FIRST_HIT','HIT_BY','SURVIVAL','TRUNCATED_HIT_TIME','CONDITIONAL_HIT_TIME','EXPECTED_REWARD','CUMULATIVE_REWARD','DISCOUNTED_REWARD','SET_HIT','SET_STAY','EXACT_VISITS','EXPECTED_VISITS','JOINT_STATES','TOTAL_VARIATION','INVARIANT_CANDIDATE','DETAILED_BALANCE','IRREDUCIBLE','COMMUNICATING_CLASSES','ABSORBING_STATES'];
const numbers=[952,953,955,956,957,958,959,960,961,962,963,964,965,966,967,968,969,970,971,972,973,974,975];
const gcd=(a,b)=>{while(b)[a,b]=[b,a%b];return a<0n?-a:a;};
const q=(n,d=1n)=>{n=BigInt(n);d=BigInt(d);if(!d)throw Error('zero denominator');if(d<0n){n=-n;d=-d;}const g=gcd(n,d);return [n/g,d/g];};
const parse=v=>typeof v==='string'&&v.includes('/')?q(...v.split('/')):q(v);
const plus=(a,b)=>q(a[0]*b[1]+b[0]*a[1],a[1]*b[1]);
const times=(a,b)=>q(a[0]*b[0],a[1]*b[1]);
const minus=(a,b)=>q(a[0]*b[1]-b[0]*a[1],a[1]*b[1]);
const divide=(a,b)=>q(a[0]*b[1],a[1]*b[0]);
const fmt=a=>a[0]+'/'+a[1];
const zero=()=>q(0),one=()=>q(1),sum=xs=>xs.reduce(plus,zero());
const transition=weights=>weights.map(row=>{const denom=row.reduce((a,b)=>a+b,0);return row.map(v=>q(v,denom));});
function paths(weights,start,steps){const P=transition(weights),out=[];function walk(history,prob){if(history.length===steps+1){out.push({history,prob});return;}const current=history.at(-1);for(let j=0;j<P.length;j++)if(P[current][j][0])walk(history.concat(j),times(prob,P[current][j]));}walk([start],one());return out;}
const prob=(items,predicate)=>sum(items.filter(predicate).map(item=>item.prob));
const distribution=(weights,start,steps)=>range(weights.length).map(j=>prob(paths(weights,start,steps),item=>item.history.at(-1)===j));
const hitAt=(history,target)=>history.indexOf(target);
function compute(tag,x){const n=x.weights.length,t=x.steps??x.secondStep??0,s=x.start??0,all=tag==='TRANSITION_POWER'?null:paths(x.weights,s,t),target=x.target;
 switch(tag){
 case 'STEP_DISTRIBUTION':return {distribution:distribution(x.weights,s,t).map(fmt)};
 case 'TRANSITION_POWER':return {transition:range(n).map(i=>distribution(x.weights,i,t).map(fmt))};
 case 'RETURN_PROBABILITY':return {probability:fmt(prob(all,item=>item.history.at(-1)===s))};
 case 'OCCUPANCY':return {expectedVisits:range(n).map(state=>fmt(sum(all.map(item=>times(item.prob,q(item.history.filter(j=>j===state).length))))))};
 case 'FIRST_HIT':return {probabilities:range(t+1).map(k=>fmt(prob(all,item=>hitAt(item.history,target)===k)))};
 case 'HIT_BY':return {probability:fmt(prob(all,item=>hitAt(item.history,target)>=0))};
 case 'SURVIVAL':return {probability:fmt(prob(all,item=>hitAt(item.history,target)<0))};
 case 'TRUNCATED_HIT_TIME':return {expected:fmt(sum(all.map(item=>times(item.prob,q(hitAt(item.history,target)<0?t:hitAt(item.history,target))))))};
 case 'CONDITIONAL_HIT_TIME':{const hits=all.filter(item=>hitAt(item.history,target)>=0),mass=sum(hits.map(item=>item.prob));return {expected:mass[0]?fmt(divide(sum(hits.map(item=>times(item.prob,q(hitAt(item.history,target))))),mass)):null};}
 case 'EXPECTED_REWARD':return {expected:fmt(sum(all.map(item=>times(item.prob,parse(x.rewards[item.history.at(-1)])))))};
 case 'CUMULATIVE_REWARD':return {expected:fmt(sum(all.map(item=>times(item.prob,sum(item.history.map(state=>parse(x.rewards[state])))))))};
 case 'DISCOUNTED_REWARD':return {expected:fmt(sum(all.map(item=>{const d=parse(x.discount);let power=one();const total=sum(item.history.map(state=>{const v=times(power,parse(x.rewards[state]));power=times(power,d);return v;}));return times(item.prob,total);}))) };
 case 'SET_HIT':return {probability:fmt(prob(all,item=>item.history.some(state=>x.targets.includes(state))))};
 case 'SET_STAY':return {probability:fmt(prob(all,item=>item.history.every(state=>x.allowed.includes(state))))};
 case 'EXACT_VISITS':return {probability:fmt(prob(all,item=>item.history.filter(state=>state===target).length===x.visits))};
 case 'EXPECTED_VISITS':return {expected:fmt(sum(all.map(item=>times(item.prob,q(item.history.filter(state=>state===target).length)))))};
 case 'JOINT_STATES':return {probability:fmt(prob(all,item=>item.history[x.firstStep]===x.firstState&&item.history[x.secondStep]===x.secondState))};
 case 'TOTAL_VARIATION':{const a=distribution(x.weights,x.startA,t),b=distribution(x.weights,x.startB,t);return {distance:fmt(divide(sum(a.map((v,j)=>{const d=minus(v,b[j]);return d[0]<0n?q(-d[0],d[1]):d;})),q(2)))};}
 case 'INVARIANT_CANDIDATE':{const pi=x.stationary.map(parse),P=transition(x.weights);return {invariant:range(n).every(j=>minus(sum(range(n).map(i=>times(pi[i],P[i][j]))),pi[j])[0]===0n)};}
 case 'DETAILED_BALANCE':{const pi=x.stationary.map(parse),P=transition(x.weights);return {reversible:range(n).every(i=>range(n).every(j=>minus(times(pi[i],P[i][j]),times(pi[j],P[j][i]))[0]===0n))};}
 case 'IRREDUCIBLE':return {irreducible:range(n).every(i=>reachable(x.weights,i).size===n)};
 case 'COMMUNICATING_CLASSES':{const reach=range(n).map(i=>reachable(x.weights,i)),used=new Set(),classes=[];for(let i=0;i<n;i++)if(!used.has(i)){const group=range(n).filter(j=>reach[i].has(j)&&reach[j].has(i));group.forEach(j=>used.add(j));classes.push(group);}return {classes};}
 case 'ABSORBING_STATES':return {states:range(n).filter(i=>x.weights[i].every((value,j)=>j===i?value===x.weights[i].reduce((v,w)=>v+w,0):value===0))};
 default:throw Error('unknown independent Markov formula '+tag);
 }
}
function reachable(weights,start){const seen=new Set([start]),queue=[start];for(let k=0;k<queue.length;k++)for(let j=0;j<weights.length;j++)if(weights[queue[k]][j]>0&&!seen.has(j)){seen.add(j);queue.push(j);}return seen;}
function sample(tag,i,r){const n=2+i%2,steps=r(5),weights=range(n).map(row=>range(n).map(col=>i%9===0?Number(row===col):i%9===1?Number(col===(row+1)%n):r(4)+(row===col?1:0)));const start=r(n),target=r(n),rewards=range(n).map(()=>r(7)-3),base={weights,start,steps};
 if(tag==='TRANSITION_POWER')return {weights,steps};
 if(['IRREDUCIBLE','COMMUNICATING_CLASSES','ABSORBING_STATES'].includes(tag))return {weights};
 if(['INVARIANT_CANDIDATE','DETAILED_BALANCE'].includes(tag)){const stationarity=i%5===0?range(n).map(()=>`1/${n}`):range(n).map((_,j)=>j===0?'1/1':'0/1');return {weights,stationary:stationarity};}
 if(tag==='TOTAL_VARIATION')return {weights,startA:start,startB:r(n),steps};
 if(tag==='JOINT_STATES'){const firstStep=r(steps+1),secondStep=firstStep+r(steps-firstStep+1);return {weights,start,firstStep,secondStep,firstState:r(n),secondState:r(n)};}
 if(['EXPECTED_REWARD','CUMULATIVE_REWARD','DISCOUNTED_REWARD'].includes(tag))return tag==='DISCOUNTED_REWARD'?{...base,rewards,discount:['0/1','1/2','1/1'][i%3]}:{...base,rewards};
 if(tag==='SET_HIT')return {...base,targets:range(n).filter(()=>r(2))};
 if(tag==='SET_STAY')return {...base,allowed:range(n).filter(()=>r(2))};
 if(tag==='EXACT_VISITS')return {...base,target,visits:r(steps+3)};
 if(['FIRST_HIT','HIT_BY','SURVIVAL','TRUNCATED_HIT_TIME','CONDITIONAL_HIT_TIME','EXPECTED_VISITS'].includes(tag))return {...base,target};
 return base;
}
const definitions=tags.map((tag,j)=>({id:`GAUSS.STATS.EXACT_MARKOV.${tag}.${numbers[j]}`,make:(i,r)=>sample(tag,i,r),reference:x=>compute(tag,x)}));
export const runFinalExactMarkovBank=options=>runFinalBank({name:'AXIOMA 23 finite-horizon exact rational Markov references',definitions,...options});
