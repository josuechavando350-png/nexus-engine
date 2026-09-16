// Bounded first-party stochastic-process and sequential decision algorithms.
// All probabilities refer to explicitly supplied finite discrete models.
const freeze=Object.freeze;
const finite=(v,label,limit=1000000)=>{if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>limit)throw new TypeError(`${label} must be finite and bounded`);return v;};
const integer=(v,label,min,max)=>{if(!Number.isSafeInteger(v)||v<min||v>max)throw new TypeError(`${label} must be an integer in [${min},${max}]`);return v;};
function distribution(input,name,n=null){
 if(!Array.isArray(input)||!input.length||input.length>32||(n!==null&&input.length!==n))throw new TypeError(`${name} length must be 1..32 and match dimension`);
 const p=input.map((v,i)=>{const x=finite(v,`${name}[${i}]`,1);if(x<0)return (()=>{throw new TypeError('negative probability');})();return x;});
 const mass=p.reduce((s,v)=>s+v,0);if(Math.abs(mass-1)>1e-12)throw new TypeError(`${name} must sum to one`);
 // Normalize accepted rounding error instead of repeatedly amplifying it in a Markov chain.
 return p.map(value=>value/mass);
}
function transition(matrix,name,n=null){
 if(!Array.isArray(matrix)||!matrix.length||matrix.length>24||(n!==null&&matrix.length!==n))throw new TypeError(`${name} invalid transition matrix`);
 return matrix.map((row,i)=>distribution(row,`${name}[${i}]`,matrix.length));
}
function multiply(p,t){const next=Array(p.length).fill(0);for(let i=0;i<p.length;i++)for(let j=0;j<p.length;j++)next[j]+=p[i]*t[i][j];return next;}
function clean(x,name){if(!Number.isFinite(x))throw new RangeError(`${name} numerical overflow`);return x;}
function model(initial,trans){const t=transition(trans,'transition');const p=distribution(initial,'initial',t.length);return {p,t,n:p.length};}
export function markovDistributionAfterSteps({initial,transition:trans,steps}){
 const {p,t}=model(initial,trans),limit=integer(steps,'steps',0,10000);
 let current=p;for(let i=0;i<limit;i++)current=multiply(current,t);
 return freeze({distribution:freeze(current.map(v=>clean(v,'Markov distribution'))),steps:limit});
}
export function markovHittingProbability({initial,transition:trans,targets,steps}){
 const {p,t,n}=model(initial,trans),limit=integer(steps,'steps',0,10000);
 if(!Array.isArray(targets)||!targets.length||targets.length>n)throw new TypeError('targets must be a nonempty bounded array');
 const ids=targets.map((v,i)=>integer(v,`targets[${i}]`,0,n-1));if(new Set(ids).size!==ids.length)throw new TypeError('duplicate targets');
 let current=[...p],hit=0;
 for(let s=0;s<=limit;s++){
  for(const id of ids){hit+=current[id];current[id]=0;}
  if(s<limit)current=multiply(current,t);
 }
 clean(hit,'hitting probability');
 if(hit < -1e-9 || hit > 1+1e-9)throw new RangeError('hitting probability mass drift');
 return freeze({hittingProbability:Math.min(1,Math.max(0,hit)),steps:limit});
}
function gaussian(a,b){const n=a.length,m=a.map((row,i)=>[...row,b[i]]);
 for(let k=0;k<n;k++){let pivot=k;for(let i=k+1;i<n;i++)if(Math.abs(m[i][k])>Math.abs(m[pivot][k]))pivot=i;
  if(Math.abs(m[pivot][k])<1e-12)throw new RangeError('singular or nonabsorbing transient Markov system');
  [m[k],m[pivot]]=[m[pivot],m[k]];const d=m[k][k];for(let j=k;j<=n;j++)m[k][j]/=d;
  for(let i=0;i<n;i++)if(i!==k){const factor=m[i][k];for(let j=k;j<=n;j++)m[i][j]-=factor*m[k][j];}
 }return m.map(row=>clean(row[n],'linear system'));
}
export function absorbingMarkovExpectedSteps({transition:trans,absorbingStates}){
 const t=transition(trans,'transition');const n=t.length;
 if(!Array.isArray(absorbingStates)||!absorbingStates.length||absorbingStates.length>n)throw new TypeError('absorbingStates must be nonempty');
 const absorbing=absorbingStates.map((id,i)=>integer(id,`absorbingStates[${i}]`,0,n-1));if(new Set(absorbing).size!==absorbing.length)throw new TypeError('duplicate absorbing states');
 for(const id of absorbing)if(t[id].some((p,j)=>p!==(j===id?1:0)))throw new TypeError('declared absorbing state is not absorbing');
 const transient=Array.from({length:n},(_,i)=>i).filter(i=>!absorbing.includes(i));
 if(!transient.length)return freeze({expectedSteps:freeze(Array(n).fill(0))});
 const a=transient.map((u,i)=>transient.map((v,j)=>(i===j?1:0)-t[u][v]));
 const solution=gaussian(a,transient.map(()=>1)),result=Array(n).fill(0);
 for(let i=0;i<transient.length;i++){
  if(solution[i]<-1e-8)throw new RangeError('invalid negative absorption time');result[transient[i]]=Math.max(0,solution[i]);
 }
 for(const u of transient){const residual=1+transient.reduce((sum,v)=>sum+t[u][v]*result[v],0)-result[u];
  if(Math.abs(residual)>1e-7*(1+result[u]))throw new RangeError('absorption-time linear residual failure');}
 return freeze({expectedSteps:freeze(result)});
}
export function markovStationaryFromUniform({transition:trans,tolerance=1e-10,maxIterations=10000}){
 const t=transition(trans,'transition'),n=t.length,tol=finite(tolerance,'tolerance',.01),cap=integer(maxIterations,'maxIterations',1,10000);
 if(tol<=0)throw new TypeError('tolerance must be positive');let p=Array(n).fill(1/n),iterations=0;
 for(;iterations<cap;iterations++){const next=multiply(p,t),difference=next.reduce((s,v,j)=>s+Math.abs(v-p[j]),0);p=next;
  if(difference<=tol){const residual=multiply(p,t).reduce((s,v,j)=>s+Math.abs(v-p[j]),0);
   if(residual>tol*2)throw new RangeError('stationary distribution residual exceeded tolerance');
   return freeze({distribution:freeze(p),iterations:iterations+1,residual});}
 }
 throw new RangeError('stationary distribution did not converge from uniform initial state');
}
function hmm({initial,transition:trans,emissions,observations}){
 const {p,t,n}=model(initial,trans);
 if(!Array.isArray(emissions)||emissions.length!==n)throw new TypeError('emissions dimension mismatch');
 const alphabet=emissions[0]?.length;
 if(!Number.isSafeInteger(alphabet)||alphabet<1||alphabet>32)throw new TypeError('emission alphabet invalid');
 const e=emissions.map((r,i)=>distribution(r,`emissions[${i}]`,alphabet));
 if(!Array.isArray(observations)||observations.length>512)throw new TypeError('observations must be a bounded array');
 const obs=observations.map((v,i)=>integer(v,`observations[${i}]`,0,alphabet-1));
 return {p,t,e,obs,n};
}
function forward(m){let a=[...m.p],logLikelihood=0,alphas=[];
 for(const observed of m.obs){const prior=alphas.length?multiply(a,m.t):a; // No transition before the first observation.
  const raw=prior.map((p,i)=>p*m.e[i][observed]),mass=raw.reduce((s,v)=>s+v,0);
  if(!(mass>0))return {zero:true};
  logLikelihood+=Math.log(mass);a=raw.map(v=>v/mass);alphas.push({alpha:a,scale:mass});
 }
 return {zero:false,logLikelihood,alphas};
}
export function hiddenMarkovForward({initial,transition,emissions,observations}){
 const m=hmm({initial,transition,emissions,observations}),f=forward(m);
 if(f.zero)return freeze({positiveLikelihood:false,logLikelihood:null,terminalPosterior:null});
 return freeze({positiveLikelihood:true,logLikelihood:f.logLikelihood,terminalPosterior:freeze(f.alphas.at(-1)?.alpha??m.p)});
}
export function hiddenMarkovViterbi({initial,transition,emissions,observations}){
 const m=hmm({initial,transition,emissions,observations}),log=v=>v===0?-Infinity:Math.log(v);
 let previous=m.p.map(log),back=[];
 for(let time=0;time<m.obs.length;time++){
  const current=Array(m.n).fill(-Infinity),from=Array(m.n).fill(-1);
  for(let state=0;state<m.n;state++){
   let best=-Infinity,chosen=-1;
   if(time===0){best=previous[state];chosen=state;}
   else for(let before=0;before<m.n;before++){
    const candidate=previous[before]+log(m.t[before][state]);if(candidate>best){best=candidate;chosen=before;}
   }
   current[state]=best+log(m.e[state][m.obs[time]]);from[state]=chosen;
  }
  previous=current;back.push(from);
 }
 if(!m.obs.length)return freeze({positiveLikelihood:true,path:freeze([]),pathLogProbability:0});
 let end=0;for(let i=1;i<m.n;i++)if(previous[i]>previous[end])end=i;
 if(previous[end]===-Infinity)return freeze({positiveLikelihood:false,path:freeze([]),pathLogProbability:null});
 const path=Array(m.obs.length);for(let time=m.obs.length-1;time>=0;time--){path[time]=end;end=back[time][end];}
 return freeze({positiveLikelihood:true,path:freeze(path),pathLogProbability:previous[path.at(-1)]});
}
export function hiddenMarkovSmoothing({initial,transition,emissions,observations}){
 const m=hmm({initial,transition,emissions,observations}),f=forward(m);
 if(f.zero)return freeze({positiveLikelihood:false,posteriors:null,logLikelihood:null});
 const t=m.obs.length,beta=Array.from({length:t},()=>Array(m.n).fill(1));
 for(let k=t-2;k>=0;k--)for(let i=0;i<m.n;i++){
  beta[k][i]=m.t[i].reduce((sum,v,j)=>sum+v*m.e[j][m.obs[k+1]]*beta[k+1][j],0)/f.alphas[k+1].scale;
 }
 const posteriors=f.alphas.map((entry,k)=>{const raw=entry.alpha.map((v,i)=>v*beta[k][i]),mass=raw.reduce((s,v)=>s+v,0);
  if(!(mass>0)||!Number.isFinite(mass))throw new RangeError('HMM smoothing normalizer invalid');
  return freeze(raw.map(v=>clean(v/mass,'HMM smoothing posterior')));
 });
 return freeze({positiveLikelihood:true,posteriors:freeze(posteriors),logLikelihood:f.logLikelihood});
}
export function poissonBinomialDistribution({probabilities}){
 if(!Array.isArray(probabilities)||probabilities.length>1024)throw new TypeError('probabilities length 0..1024 required');
 const ps=probabilities.map((v,i)=>{const x=finite(v,`probabilities[${i}]`,1);if(x<0)return (()=>{throw new TypeError('negative probability');})();return x;});
 let d=[1];for(const p of ps){const next=Array(d.length+1).fill(0);for(let i=0;i<d.length;i++){next[i]+=d[i]*(1-p);next[i+1]+=d[i]*p;}d=next;}
 const mass=d.reduce((s,v)=>s+v,0);if(Math.abs(mass-1)>1e-9)throw new RangeError('Poisson-binomial probability mass drift');
 return freeze({probabilities:freeze(d)});
}
function mdp({transition:trans,rewards}){
 if(!Array.isArray(trans)||trans.length<1||trans.length>16||!Array.isArray(trans[0])||trans[0].length<1||trans[0].length>16)throw new TypeError('MDP state/action bounds exceeded');
 const n=trans.length,a=trans[0].length;
 const t=trans.map((actions,i)=>{if(!Array.isArray(actions)||actions.length!==a)throw new TypeError('MDP action dimensions disagree');
  return actions.map((p,j)=>distribution(p,`transition[${i}][${j}]`,n));});
 if(!Array.isArray(rewards)||rewards.length!==n)throw new TypeError('MDP rewards shape invalid');
 const r=rewards.map((row,i)=>{if(!Array.isArray(row)||row.length!==a)throw new TypeError('MDP reward action shape invalid');return row.map((v,j)=>finite(v,`rewards[${i}][${j}]`,10000));});
 return {n,a,t,r};
}
function expectation(p,values){return p.reduce((sum,v,i)=>sum+v*values[i],0);}
export function finiteHorizonMarkovDecision({transition,rewards,horizon,discount=1}){
 const m=mdp({transition,rewards}),cap=integer(horizon,'horizon',0,256),gamma=finite(discount,'discount',1);
 if(gamma<0)throw new TypeError('discount must be nonnegative');
 let next=Array(m.n).fill(0),policies=[];
 for(let step=cap-1;step>=0;step--){const values=[],policy=[];
  for(let s=0;s<m.n;s++){
   let best=-Infinity,chosen=-1;for(let a=0;a<m.a;a++){
    const q=m.r[s][a]+gamma*expectation(m.t[s][a],next);if(q>best){best=q;chosen=a;}}
   values[s]=clean(best,'finite MDP');policy[s]=chosen;
  }policies.unshift(freeze(policy));next=values;
 }
 return freeze({values:freeze(next),policies:freeze(policies),horizon:cap});
}
export function discountedMarkovDecision({transition,rewards,discount,tolerance=1e-9,maxIterations=10000}){
 const m=mdp({transition,rewards}),gamma=finite(discount,'discount',1),tol=finite(tolerance,'tolerance',1);
 const limit=integer(maxIterations,'maxIterations',1,10000);
 if(gamma<0||gamma>=1||tol<=0)throw new TypeError('discount must be [0,1), tolerance positive');
 let values=Array(m.n).fill(0),iterations=0;
 for(;iterations<limit;iterations++){
  const next=values.map((_,s)=>Math.max(...m.t[s].map((p,a)=>m.r[s][a]+gamma*expectation(p,values))));
  const change=Math.max(...next.map((v,s)=>Math.abs(v-values[s])));values=next;
  if(!Number.isFinite(change))throw new RangeError('discounted MDP overflow');
  if(change*gamma/(1-gamma)<=tol){const policy=values.map((_,s)=>{
   let best=-Infinity,choice=0;for(let a=0;a<m.a;a++){
    const q=m.r[s][a]+gamma*expectation(m.t[s][a],values);if(q>best){best=q;choice=a;}}
   return choice;
  });
   return freeze({values:freeze(values),greedyPolicy:freeze(policy),iterations:iterations+1,errorBound:change*gamma/(1-gamma)});
  }
 }
 throw new RangeError('discounted MDP did not converge within budget');
}
export function fixedPolicyValueEvaluation({transition,rewards,policy,discount,tolerance=1e-9,maxIterations=10000}){
 const m=mdp({transition,rewards}),gamma=finite(discount,'discount',1),tol=finite(tolerance,'tolerance',1);
 const cap=integer(maxIterations,'maxIterations',1,10000);
 if(gamma<0||gamma>=1||tol<=0)throw new TypeError('invalid discount or tolerance');
 if(!Array.isArray(policy)||policy.length!==m.n)throw new TypeError('policy state dimensions invalid');
 const choices=policy.map((v,i)=>integer(v,`policy[${i}]`,0,m.a-1));let values=Array(m.n).fill(0);
 for(let step=0;step<cap;step++){
  const next=values.map((_,s)=>m.r[s][choices[s]]+gamma*expectation(m.t[s][choices[s]],values));
  const delta=Math.max(...next.map((v,i)=>Math.abs(v-values[i])));values=next;
  if(!Number.isFinite(delta))throw new RangeError('policy evaluation overflow');
  if(gamma*delta/(1-gamma)<=tol)return freeze({values:freeze(values),iterations:step+1,errorBound:gamma*delta/(1-gamma)});
 }
 throw new RangeError('fixed policy evaluation did not converge');
}
export function markovExpectedCumulativeReward({initial,transition:trans,stateRewards,steps,discount=1}){
 const {p,t,n}=model(initial,trans),cap=integer(steps,'steps',0,10000),gamma=finite(discount,'discount',1);
 if(gamma<0)throw new TypeError('discount must be nonnegative');
 if(!Array.isArray(stateRewards)||stateRewards.length!==n)throw new TypeError('stateRewards dimension mismatch');
 const r=stateRewards.map((v,i)=>finite(v,`stateRewards[${i}]`,10000));let state=p,total=0,factor=1;
 for(let i=0;i<cap;i++){
  total=clean(total+factor*expectation(state,r),'Markov expected reward');factor*=gamma;state=multiply(state,t);
 }
 return freeze({expectedCumulativeReward:total,terminalDistribution:freeze(state),steps:cap});
}