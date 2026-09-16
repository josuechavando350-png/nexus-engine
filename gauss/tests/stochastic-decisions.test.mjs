import test from 'node:test';
import assert from 'node:assert/strict';
import {
 markovDistributionAfterSteps,markovHittingProbability,absorbingMarkovExpectedSteps,
 markovStationaryFromUniform,hiddenMarkovForward,hiddenMarkovViterbi,hiddenMarkovSmoothing,
 poissonBinomialDistribution,finiteHorizonMarkovDecision,discountedMarkovDecision,
 fixedPolicyValueEvaluation,markovExpectedCumulativeReward,
} from '../core/layers/stochastic-decisions.mjs';
let seed=0x30904a1c;function random(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/2**32;}
const randint=n=>Math.floor(random()*n);
function near(a,b,eps=1e-8){assert(Math.abs(a-b)<=eps*(1+Math.max(Math.abs(a),Math.abs(b))),`${a} != ${b}`);}
function randomDist(n){const a=Array.from({length:n},()=>1+randint(9)),sum=a.reduce((s,v)=>s+v,0);return a.map(v=>v/sum);}
function enumerate(p,t,steps){let out=Array(p.length).fill(0);function visit(state,prob,step){if(step===steps){out[state]+=prob;return;}for(let v=0;v<p.length;v++)visit(v,prob*t[state][v],step+1);}
 for(let s=0;s<p.length;s++)visit(s,p[s],0);return out;}
test('Markov n-step propagation matches independent complete path enumeration',()=>{
 for(let run=0;run<130;run++){
  const n=2+randint(3),p=randomDist(n),t=Array.from({length:n},()=>randomDist(n)),steps=randint(5);
  const got=markovDistributionAfterSteps({initial:p,transition:t,steps}).distribution;
  enumerate(p,t,steps).forEach((v,i)=>near(got[i],v));near(got.reduce((a,b)=>a+b,0),1);
 }
});
test('finite Markov first-hit probabilities agree with absorbing path enumeration',()=>{
 for(let run=0;run<140;run++){
  const n=2+randint(3),p=randomDist(n),t=Array.from({length:n},()=>randomDist(n)),steps=randint(5),target=randint(n);
  let hit=0;function visit(s,mass,k){if(s===target){hit+=mass;return;}if(k===steps)return;
    for(let v=0;v<n;v++)visit(v,mass*t[s][v],k+1);}
  for(let s=0;s<n;s++)visit(s,p[s],0);
  near(markovHittingProbability({initial:p,transition:t,targets:[target],steps}).hittingProbability,hit);
 }
});
test('absorbing Markov times reproduce a separate geometric waiting-time oracle and reject closed transient classes',()=>{
 for(let run=0;run<170;run++){
  const p=(1+randint(90))/100;const t=[[1-p,p],[0,1]];
  const got=absorbingMarkovExpectedSteps({transition:t,absorbingStates:[1]});near(got.expectedSteps[0],1/p);near(got.expectedSteps[1],0);
 }
 assert.throws(()=>absorbingMarkovExpectedSteps({transition:[[1,0],[0,1]],absorbingStates:[1]}),/singular|nonabsorbing/);
});
test('stationary distribution from uniform matches analytic two-state equilibrium when chain is ergodic',()=>{
 for(let run=0;run<140;run++){
  const a=.05+.9*random(),b=.05+.9*random(),t=[[1-a,a],[b,1-b]];
  const out=markovStationaryFromUniform({transition:t,tolerance:1e-10});near(out.distribution[0],b/(a+b),1e-8);near(out.distribution[1],a/(a+b),1e-8);
  assert(out.residual<1e-9);
 }
 assert.throws(()=>markovStationaryFromUniform({transition:[[0,.5,.5],[1,0,0],[1,0,0]],maxIterations:20}),/did not converge/);
});
function hmmEnumerate(m){const {initial:p,transition:t,emissions:e,observations:o}=m,n=p.length;
 let total=0,best=-1,pathBest=null,post=Array.from({length:o.length},()=>Array(n).fill(0));
 function visit(path,mass){const k=path.length;if(k===o.length){total+=mass;if(mass>best){best=mass;pathBest=path;}for(let j=0;j<o.length;j++)post[j][path[j]]+=mass;return;}
 for(let s=0;s<n;s++){const prior=k===0?p[s]:t[path[k-1]][s];visit([...path,s],mass*prior*e[s][o[k]]);}}
 visit([],1);return {total,best,pathBest,post:post.map(row=>row.map(v=>v/total))};}
test('HMM forward, Viterbi and smoothed marginals match independent enumeration of all hidden paths',()=>{
 for(let run=0;run<160;run++){
  const n=2+randint(2),m=2+randint(2),p=randomDist(n),t=Array.from({length:n},()=>randomDist(n)),e=Array.from({length:n},()=>randomDist(m));
  const observations=Array.from({length:1+randint(5)},()=>randint(m)),args={initial:p,transition:t,emissions:e,observations};
  const reference=hmmEnumerate(args),f=hiddenMarkovForward(args),v=hiddenMarkovViterbi(args),s=hiddenMarkovSmoothing(args);
  assert(f.positiveLikelihood&&v.positiveLikelihood&&s.positiveLikelihood);near(Math.exp(f.logLikelihood),reference.total);
  near(Math.exp(v.pathLogProbability),reference.best);
  const vMass=v.path.reduce((mass,state,k)=>mass*(k?t[v.path[k-1]][state]:p[state])*e[state][observations[k]],1);near(vMass,reference.best);
  s.posteriors.forEach((row,k)=>row.forEach((mass,state)=>near(mass,reference.post[k][state])));
  f.terminalPosterior.forEach((mass,state)=>near(mass,reference.post.at(-1)[state]));
 }
});
test('HMM gracefully reports zero-probability observation without serializing Infinity',()=>{
 const args={initial:[1,0],transition:[[1,0],[0,1]],emissions:[[1,0],[1,0]],observations:[1]};
 assert.deepEqual(hiddenMarkovForward(args),{positiveLikelihood:false,logLikelihood:null,terminalPosterior:null});
 assert.deepEqual(hiddenMarkovViterbi(args),{positiveLikelihood:false,path:[],pathLogProbability:null});
 assert.deepEqual(hiddenMarkovSmoothing(args),{positiveLikelihood:false,posteriors:null,logLikelihood:null});
});
test('Poisson-binomial full distribution equals independent enumeration of Bernoulli outcomes',()=>{
 for(let run=0;run<180;run++){
  const p=Array.from({length:randint(11)},()=>random()),got=poissonBinomialDistribution({probabilities:p}).probabilities;
  const oracle=Array(p.length+1).fill(0);for(let mask=0;mask<(1<<p.length);mask++){
   let probability=1,wins=0;for(let j=0;j<p.length;j++){if(mask&(1<<j)){probability*=p[j];wins++;}else probability*=1-p[j];}
   oracle[wins]+=probability;
  }oracle.forEach((x,i)=>near(got[i],x));
 }
});
function testMdp(){const n=2,a=2,t=Array.from({length:n},()=>Array.from({length:a},()=>randomDist(n))),r=Array.from({length:n},()=>Array.from({length:a},()=>randint(13)-4));return {transition:t,rewards:r};}
test('finite-horizon MDP values and policies match independent exhaustive action-tree oracle',()=>{
 for(let run=0;run<140;run++){
  const m=testMdp(),horizon=randint(6),discount=random(),got=finiteHorizonMarkovDecision({...m,horizon,discount});
  function oracle(s,h){if(!h)return 0;return Math.max(...m.transition[s].map((p,a)=>m.rewards[s][a]+discount*p.reduce((sum,v,j)=>sum+v*oracle(j,h-1),0)));}
  got.values.forEach((value,s)=>near(value,oracle(s,horizon)));
  assert.equal(got.policies.length,horizon);
 }
});
test('discounted MDP value iteration agrees with explicit two-state policy enumeration and Bellman residual',()=>{
 for(let run=0;run<100;run++){
  const m=testMdp(),discount=.1+.8*random(),actual=discountedMarkovDecision({...m,discount});
  let optimal=[-Infinity,-Infinity];
  for(let p0=0;p0<2;p0++)for(let p1=0;p1<2;p1++){
   const p=[p0,p1],a=m.transition[0][p0],b=m.transition[1][p1],r0=m.rewards[0][p0],r1=m.rewards[1][p1];
   const x=1-discount*a[0],y=-discount*a[1],z=-discount*b[0],w=1-discount*b[1],det=x*w-y*z;
   const value0=(r0*w-y*r1)/det,value1=(x*r1-z*r0)/det;
   optimal[0]=Math.max(optimal[0],value0);optimal[1]=Math.max(optimal[1],value1);
  }
  actual.values.forEach((v,i)=>near(v,optimal[i],1e-7));
  actual.values.forEach((v,s)=>near(v,Math.max(...m.transition[s].map((p,a)=>m.rewards[s][a]+discount*p.reduce((sum,x,j)=>sum+x*actual.values[j],0))),1e-7));
 }
});
test('fixed policy evaluation agrees with direct two-state linear solve',()=>{
 for(let run=0;run<120;run++){
  const m=testMdp(),policy=[randint(2),randint(2)],discount=.05+.85*random();
  const a=m.transition[0][policy[0]],b=m.transition[1][policy[1]],r0=m.rewards[0][policy[0]],r1=m.rewards[1][policy[1]];
  const x=1-discount*a[0],y=-discount*a[1],z=-discount*b[0],w=1-discount*b[1],det=x*w-y*z;
  const reference=[(r0*w-y*r1)/det,(x*r1-z*r0)/det];
  const actual=fixedPolicyValueEvaluation({...m,policy,discount});actual.values.forEach((v,i)=>near(v,reference[i],1e-7));
 }
});
test('expected Markov cumulative state rewards match independent path enumeration',()=>{
 for(let run=0;run<130;run++){
  const n=2+randint(3),p=randomDist(n),t=Array.from({length:n},()=>randomDist(n)),r=Array.from({length:n},()=>randint(15)-7),steps=randint(5),discount=random();
  let expected=0;
  function visit(s,mass,step){if(step===steps)return;expected+=mass*discount**step*r[s];for(let j=0;j<n;j++)visit(j,mass*t[s][j],step+1);}
  for(let s=0;s<n;s++)visit(s,p[s],0);
  const got=markovExpectedCumulativeReward({initial:p,transition:t,stateRewards:r,steps,discount});near(got.expectedCumulativeReward,expected);
  enumerate(p,t,steps).forEach((v,i)=>near(got.terminalDistribution[i],v));
 }
});
test('stochastic operators reject malformed dimensions, probabilities and convergence claims',()=>{
 assert.throws(()=>markovDistributionAfterSteps({initial:[.7,.5],transition:[[1,0],[0,1]],steps:1}),/sum to one/);
 assert.throws(()=>markovHittingProbability({initial:[1,0],transition:[[1,0],[0,1]],targets:[0,0],steps:1}),/duplicate/);
 assert.throws(()=>absorbingMarkovExpectedSteps({transition:[[.5,.5],[0,1]],absorbingStates:[0]}),/not absorbing/);
 assert.throws(()=>markovStationaryFromUniform({transition:[[.7,.3],[.2,.8]],maxIterations:1,tolerance:1e-14}),/did not converge/);
 assert.throws(()=>hiddenMarkovForward({initial:[1],transition:[[1]],emissions:[[1]],observations:[1]}),/integer/);
 assert.throws(()=>poissonBinomialDistribution({probabilities:[1.1]}),/finite/);
 assert.throws(()=>finiteHorizonMarkovDecision({transition:[[[1]]],rewards:[[Infinity]],horizon:1}),/finite/);
 assert.throws(()=>discountedMarkovDecision({transition:[[[1]]],rewards:[[1]],discount:1}),/discount/);
 assert.throws(()=>fixedPolicyValueEvaluation({transition:[[[1]]],rewards:[[1]],policy:[1],discount:.5}),/policy/);
 assert.throws(()=>markovExpectedCumulativeReward({initial:[1],transition:[[1]],stateRewards:[3,4],steps:1}),/dimension/);
});

test('a nearly absorbing state is not silently certified as absorbing',()=>{
 const matrix=[[1-5e-13,5e-13],[0,1]];
 assert.throws(()=>absorbingMarkovExpectedSteps({transition:matrix,absorbingStates:[0,1]}),/not absorbing/);
});

test('accepted round-off is normalized before repeated stochastic transitions',()=>{
 const t=[[1,1e-13],[0,1]];
 const result=markovDistributionAfterSteps({initial:[1,0],transition:t,steps:10000});
 near(result.distribution.reduce((sum,v)=>sum+v,0),1,1e-12);
 assert(result.distribution.every(value=>value>=0&&value<=1));
 const hit=markovHittingProbability({initial:[1,0],transition:t,targets:[0],steps:10000});
 near(hit.hittingProbability,1,1e-12);
});