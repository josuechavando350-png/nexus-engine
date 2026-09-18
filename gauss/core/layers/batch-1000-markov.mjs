// Exact rational finite-horizon discrete Markov chain computations; no simulation or external RNG.
import {object,arr,int,freeze,entries,range,q,qa,qs,qm,qd,qstr,zero,one} from './batch-1000-common.mjs';
const Z=zero(),O=one();
const f=x=>{object(x,['weights']);const rows=arr(x.weights,'weights',1,5),n=rows.length;return rows.map((r,i)=>{const v=arr(r,`weights[${i}]`,n,n).map((a,j)=>int(a,`weights[${i}][${j}]`,0,100));const total=v.reduce((a,b)=>a+b,0);if(total===0)throw new TypeError('each transition row needs positive total weight');return v.map(w=>qd(q(w),q(total)));});};
const sample={weights:[[2,1,0],[0,1,1],[1,0,1]]};
const starter=x=>{object(x,['weights','start','steps']);const p=f({weights:x.weights}),n=p.length;return [p,int(x.start,'start',0,n-1),int(x.steps,'steps',0,12)];};
const hitting=x=>{object(x,['weights','start','steps','target']);const [p,s,t]=starter({weights:x.weights,start:x.start,steps:x.steps});return [p,s,t,int(x.target,'target',0,p.length-1)];};
const rewards=x=>{object(x,['weights','start','steps','rewards']);const [p,s,t]=starter({weights:x.weights,start:x.start,steps:x.steps}),r=arr(x.rewards,'rewards',p.length,p.length).map((v,i)=>q(v));return [p,s,t,r];};
const add=(a,b)=>a.map((v,i)=>qa(v,b[i]));
const mul=(a,b)=>a.map(row=>range(b[0].length).map(j=>row.reduce((s,v,k)=>qa(s,qm(v,b[k][j])),Z)));
const eye=n=>range(n).map(i=>range(n).map(j=>i===j?O:Z));
const power=(p,k)=>{let r=eye(p.length),a=p;while(k){if(k%2)r=mul(r,a);k=Math.floor(k/2);if(k)a=mul(a,a);}return r;};
const dist=(p,s,k)=>power(p,k)[s];
const fmt=a=>a.map(qstr);
const dot=(a,b)=>a.reduce((s,v,i)=>qa(s,qm(v,b[i])),Z);
function firstHits(p,s,T,target){let active=range(p.length).map(i=>i===s?O:Z),hits=[];if(s===target){hits.push(O);active[target]=Z;}else hits.push(Z);for(let t=1;t<=T;t++){const next=active.map((_,j)=>active.reduce((v,x,i)=>qa(v,qm(x,p[i][j])),Z));hits.push(next[target]);next[target]=Z;active=next;}return hits;}
const total=a=>a.reduce(qa,Z);
const stable=(p,s,T)=>{let active=range(p.length).map(i=>i===s?O:Z),result=[active];for(let t=0;t<T;t++){active=range(p.length).map(j=>active.reduce((v,x,i)=>qa(v,qm(x,p[i][j])),Z));result.push(active);}return result;};
export function markovRationalTransition(x){return freeze({transition:f(x).map(fmt)});}
export function markovStateDistribution(x){const[p,s,t]=starter(x);return freeze({distribution:fmt(dist(p,s,t))});}
export function markovMatrixPower(x){object(x,['weights','steps']);const p=f({weights:x.weights}),t=int(x.steps,'steps',0,12);return freeze({transition:power(p,t).map(fmt)});}
export function markovPathProbability(x){object(x,['weights','path']);const p=f({weights:x.weights}),path=arr(x.path,'path',1,13).map(v=>int(v,'state',0,p.length-1));let prob=O;for(let i=1;i<path.length;i++)prob=qm(prob,p[path[i-1]][path[i]]);return freeze({probability:qstr(prob)});}
export function markovReturnProbability(x){const[p,s,t]=starter(x);return freeze({probability:qstr(dist(p,s,t)[s])});}
export function markovOccupancy(x){const[p,s,t]=starter(x),rows=stable(p,s,t),tot=range(p.length).map(j=>total(rows.map(row=>row[j])));return freeze({expectedVisits:fmt(tot)});}
export function markovFirstHitDistribution(x){const[p,s,t,target]=hitting(x);return freeze({probabilities:fmt(firstHits(p,s,t,target))});}
export function markovHitByHorizon(x){const[p,s,t,target]=hitting(x);return freeze({probability:qstr(total(firstHits(p,s,t,target)))});}
export function markovSurvivalToHorizon(x){const[p,s,t,target]=hitting(x);return freeze({probability:qstr(qs(O,total(firstHits(p,s,t,target))))});}
export function markovTruncatedHitTime(x){const[p,s,t,target]=hitting(x),h=firstHits(p,s,t,target);let v=Z;for(let k=0;k<t;k++)v=qa(v,qs(O,total(h.slice(0,k+1))));return freeze({expected:qstr(v)});}
export function markovConditionalHitTime(x){const[p,s,t,target]=hitting(x),h=firstHits(p,s,t,target),prob=total(h);return freeze({expected:prob.n? qstr(qd(total(h.map((v,i)=>qm(q(i),v))),prob)):null});}
export function markovExpectedReward(x){const[p,s,t,r]=rewards(x);return freeze({expected:qstr(dot(dist(p,s,t),r))});}
export function markovCumulativeReward(x){const[p,s,t,r]=rewards(x);return freeze({expected:qstr(total(stable(p,s,t).map(row=>dot(row,r))))});}
export function markovDiscountedReward(x){object(x,['weights','start','steps','rewards','discount']);const[p,s,t,r]=rewards({weights:x.weights,start:x.start,steps:x.steps,rewards:x.rewards}),d=q(x.discount);if(d.n<0n||d.n>d.d)throw new RangeError('discount outside [0,1]');let pow=O,v=Z;for(const row of stable(p,s,t)){v=qa(v,qm(pow,dot(row,r)));pow=qm(pow,d);}return freeze({expected:qstr(v)});}
export function markovSetHit(x){object(x,['weights','start','steps','targets']);const[p,s,t]=starter({weights:x.weights,start:x.start,steps:x.steps}),tar=new Set(arr(x.targets,'targets',0,p.length).map(v=>int(v,'target',0,p.length-1)));if(tar.size!==x.targets.length)throw new TypeError('duplicate target');let a=range(p.length).map(i=>i===s&&!tar.has(i)?O:Z),hit=tar.has(s)?O:Z;for(let k=1;k<=t;k++){const b=range(p.length).map(j=>a.reduce((v,x,i)=>qa(v,qm(x,p[i][j])),Z));hit=qa(hit,total([...tar].map(j=>b[j])));tar.forEach(j=>b[j]=Z);a=b;}return freeze({probability:qstr(hit)});}
export function markovSetStay(x){object(x,['weights','start','steps','allowed']);const[p,s,t]=starter({weights:x.weights,start:x.start,steps:x.steps}),allowed=new Set(arr(x.allowed,'allowed',0,p.length).map(v=>int(v,'allowed state',0,p.length-1)));if(allowed.size!==x.allowed.length)throw new TypeError('duplicate allowed');let a=range(p.length).map(i=>i===s&&allowed.has(i)?O:Z);for(let k=0;k<t;k++)a=range(p.length).map(j=>allowed.has(j)?a.reduce((v,x,i)=>qa(v,qm(x,p[i][j])),Z):Z);return freeze({probability:qstr(total(a))});}
export function markovExactVisits(x){object(x,['weights','start','steps','target','visits']);const[p,s,t,tar]=hitting({weights:x.weights,start:x.start,steps:x.steps,target:x.target}),v=int(x.visits,'visits',0,13);if(v>t+1)return freeze({probability:'0/1'});const dp=range(p.length).map(i=>range(t+2).map(k=>i===s&&k===(s===tar?1:0)?O:Z));let active=dp;for(let h=0;h<t;h++){const next=range(p.length).map(()=>range(t+2).map(()=>Z));for(let i=0;i<p.length;i++)for(let k=0;k<=t;k++)for(let j=0;j<p.length;j++)next[j][k+(j===tar?1:0)]=qa(next[j][k+(j===tar?1:0)],qm(active[i][k],p[i][j]));active=next;}return freeze({probability:qstr(total(active.map(row=>row[v])))});}
export function markovExpectedVisits(x){const[p,s,t,target]=hitting(x);return freeze({expected:qstr(total(stable(p,s,t).map(row=>row[target])))});}
export function markovJointStateProbability(x){object(x,['weights','start','firstStep','secondStep','firstState','secondState']);const p=f({weights:x.weights}),s=int(x.start,'start',0,p.length-1),t=int(x.firstStep,'firstStep',0,12),u=int(x.secondStep,'secondStep',t,12),a=int(x.firstState,'firstState',0,p.length-1),b=int(x.secondState,'secondState',0,p.length-1);return freeze({probability:qstr(qm(dist(p,s,t)[a],power(p,u-t)[a][b]))});}
export function markovStartTotalVariation(x){object(x,['weights','startA','startB','steps']);const p=f({weights:x.weights}),a=int(x.startA,'startA',0,p.length-1),b=int(x.startB,'startB',0,p.length-1),t=int(x.steps,'steps',0,12),d=dist(p,a,t),e=dist(p,b,t),sum=total(d.map((v,i)=>{const r=qs(v,e[i]);return r.n<0n?qs(Z,r):r;}));return freeze({distance:qstr(qd(sum,q(2)))});}
function candidate(x){object(x,['weights','stationary']);const p=f({weights:x.weights}),a=arr(x.stationary,'stationary',p.length,p.length).map(q);if(a.some(v=>v.n<0n)||total(a).n!==total(a).d)throw new TypeError('candidate must be normalized nonnegative probabilities');return [p,a];}
export function markovCandidateInvariant(x){const[p,a]=candidate(x);return freeze({invariant:mul([a],p)[0].every((v,i)=>qs(v,a[i]).n===0n)});}
export function markovCandidateReversible(x){const[p,a]=candidate(x);return freeze({reversible:p.every((r,i)=>r.every((v,j)=>qs(qm(a[i],v),qm(a[j],p[j][i])).n===0n))});}
function reachable(p,s){const seen=new Set([s]),queue=[s];for(let k=0;k<queue.length;k++)for(let j=0;j<p.length;j++)if(p[queue[k]][j].n>0n&&!seen.has(j)){seen.add(j);queue.push(j);}return seen;}
export function markovIrreducible(x){const p=f(x);return freeze({irreducible:range(p.length).every(i=>reachable(p,i).size===p.length)});}
export function markovCommunicatingClasses(x){const p=f(x),reach=range(p.length).map(i=>reachable(p,i)),used=new Set(),classes=[];for(let i=0;i<p.length;i++)if(!used.has(i)){const c=range(p.length).filter(j=>reach[i].has(j)&&reach[j].has(i));c.forEach(j=>used.add(j));classes.push(c);}return freeze({classes});}
export function markovAbsorbingStates(x){const p=f(x);return freeze({states:range(p.length).filter(i=>p[i].every((v,j)=>j===i?qs(v,O).n===0n:v.n===0n))});}
const S={...sample,start:0,steps:5},H={...S,target:2},R={...S,rewards:[2,-1,3]};
const specs=[
 ['NORMALIZE','Exact rational normalization of integer transition weights',markovRationalTransition,sample],
 ['STEP_DISTRIBUTION','Exact finite-step Markov state distribution',markovStateDistribution,S],
 ['TRANSITION_POWER','Exact finite-step transition matrix by squaring',markovMatrixPower,{...sample,steps:5}],
 ['PATH_PROBABILITY','Exact conditional probability of a supplied state path',markovPathProbability,{...sample,path:[0,1,2,0]}],
 ['RETURN_PROBABILITY','Exact t-step return probability',markovReturnProbability,S],
 ['OCCUPANCY','Expected visits per state including time zero',markovOccupancy,S],
 ['FIRST_HIT','Finite-horizon first-hitting-time distribution',markovFirstHitDistribution,H],
 ['HIT_BY','Exact probability of hitting a state by horizon',markovHitByHorizon,H],
 ['SURVIVAL','Exact probability of avoiding target through horizon',markovSurvivalToHorizon,H],
 ['TRUNCATED_HIT_TIME','Exact expected minimum of target hitting time and horizon',markovTruncatedHitTime,H],
 ['CONDITIONAL_HIT_TIME','Expected first-hitting time conditioned on hit by horizon',markovConditionalHitTime,H],
 ['EXPECTED_REWARD','Exact expected reward at one future time',markovExpectedReward,R],
 ['CUMULATIVE_REWARD','Exact undiscounted expected accumulated reward through horizon',markovCumulativeReward,R],
 ['DISCOUNTED_REWARD','Exact finite-horizon discounted expected accumulated reward',markovDiscountedReward,{...R,discount:'1/2'}],
 ['SET_HIT','Finite-horizon probability of reaching any target in a set',markovSetHit,{...S,targets:[1,2]}],
 ['SET_STAY','Finite-horizon probability of remaining in a specified state set',markovSetStay,{...S,allowed:[0,1]}],
 ['EXACT_VISITS','Exact probability of k target visits including initial state',markovExactVisits,{...H,visits:2}],
 ['EXPECTED_VISITS','Expected number of visits to a target state through horizon',markovExpectedVisits,H],
 ['JOINT_STATES','Two-time joint-state probability from Chapman-Kolmogorov law',markovJointStateProbability,{...sample,start:0,firstStep:2,secondStep:5,firstState:1,secondState:2}],
 ['TOTAL_VARIATION','Exact total-variation distance between two start states',markovStartTotalVariation,{...sample,startA:0,startB:2,steps:5}],
 ['INVARIANT_CANDIDATE','Verify exact stationary-distribution fixed-point equation',markovCandidateInvariant,{...sample,stationary:['3/10','4/10','3/10']}],
 ['DETAILED_BALANCE','Verify detailed-balance reversibility for supplied distribution',markovCandidateReversible,{...sample,stationary:['3/10','4/10','3/10']}],
 ['IRREDUCIBLE','Positive-transition reachability irreducibility predicate',markovIrreducible,sample],
 ['COMMUNICATING_CLASSES','Strong communicating-state equivalence classes',markovCommunicatingClasses,sample],
 ['ABSORBING_STATES','All certain self-loop absorbing states',markovAbsorbingStates,sample],
];
export const EXACT_MARKOV_1000=entries(specs,'STATS.EXACT_MARKOV','STATISTICS_PROBABILITY',951);
