import {object,array,integer,number,id,unique} from './shared.mjs';
import {vector,dot} from './numerics.mjs';
/** Maximum-entropy finite-horizon tabular inverse RL under explicitly known interventional action dynamics. */
export function inferFiniteCausalReward(input){
 object(input,'IRL',['states','actions','transitions','features','demonstrations','horizon','iterations','learningRate','l2'],['states','actions','transitions','features','demonstrations','horizon']);
 const states=unique(array(input.states,'states',2,32).map((v,i)=>id(v,`states[${i}]`)),'states'),actions=unique(array(input.actions,'actions',2,8).map((v,i)=>id(v,`actions[${i}]`)),'actions');
 const S=states.length,A=actions.length,sm=new Map(states.map((v,i)=>[v,i])),am=new Map(actions.map((v,i)=>[v,i]));
 const H=integer(input.horizon,'horizon',2,16),iters=integer(input.iterations??300,'iterations',1,2000),lr=number(input.learningRate??0.15,'learningRate',1e-5,1),l2=number(input.l2??0.001,'l2',0,1);
 const features=array(input.features,'features',S,S).map((x,i)=>vector(x,`features[${i}]`,1,12)),D=features[0].length;if(features.some(x=>x.length!==D))throw new TypeError('feature widths differ');
 const T=array(input.transitions,'transitions',S,S).map((rows,s)=>array(rows,`transitions[${s}]`,A,A).map((probs,a)=>{
  const p=vector(probs,`transitions[${s}][${a}]`,S,S);if(p.some(v=>v<0)||Math.abs(p.reduce((v,w)=>v+w,0)-1)>1e-10)throw new TypeError('transition rows must be probabilities summing to one');return p;
 }));
 const demonstrations=array(input.demonstrations,'demonstrations',1,256).map((demo,i)=>{
  object(demo,`demonstration[${i}]`,['states','actions']);const st=array(demo.states,'states',H+1,H+1).map(x=>sm.get(x)),ac=array(demo.actions,'actions',H,H).map(x=>am.get(x));
  if(st.some(x=>x===undefined)||ac.some(x=>x===undefined))throw new TypeError('unknown state or action in demonstration');
  for(let t=0;t<H;t++)if(T[st[t]][ac[t]][st[t+1]]===0)throw new TypeError('demonstration impossible under supplied transitions');
  return {st,ac};
 });
 const empirical=Array(D).fill(0),start=Array(S).fill(0);
 for(const {st} of demonstrations){start[st[0]]+=1/demonstrations.length;for(let t=0;t<H;t++)for(let k=0;k<D;k++)empirical[k]+=features[st[t]][k]/demonstrations.length;}
 const policyFor=w=>{
  const V=Array.from({length:H+1},()=>Array(S).fill(0)),policy=Array.from({length:H},()=>Array.from({length:S},()=>Array(A).fill(0)));
  for(let t=H-1;t>=0;t--)for(let s=0;s<S;s++){
   const q=Array.from({length:A},(_,a)=>dot(features[s],w)+dot(T[s][a],V[t+1]));
   const mx=Math.max(...q),den=q.reduce((v,x)=>v+Math.exp(x-mx),0);V[t][s]=mx+Math.log(den);policy[t][s]=q.map(x=>Math.exp(x-mx)/den);
  }return policy;
 };
 const expected=policy=>{
  let distribution=[...start],counts=Array(D).fill(0);
  for(let t=0;t<H;t++){
   for(let s=0;s<S;s++)for(let k=0;k<D;k++)counts[k]+=distribution[s]*features[s][k];
   const next=Array(S).fill(0);for(let s=0;s<S;s++)for(let a=0;a<A;a++)for(let j=0;j<S;j++)next[j]+=distribution[s]*policy[t][s][a]*T[s][a][j];distribution=next;
  }return counts;
 };
 let weights=Array(D).fill(0),grad=Array(D).fill(0);
 for(let iter=0;iter<iters;iter++){
  const exp=expected(policyFor(weights));grad=weights.map((w,k)=>empirical[k]-exp[k]-l2*w);
  weights=weights.map((w,k)=>Math.max(-30,Math.min(30,w+lr*grad[k])));
 }
 const policy=policyFor(weights),exp=expected(policy);
 return {domain:'FINITE_HORIZON_MAXENT_IRL_KNOWN_ACTION_TRANSITIONS',weights,empiricalFeatureCounts:empirical,expectedFeatureCounts:exp,gradientNorm:Math.hypot(...grad),policy:policy.map((rows,t)=>({t,states:rows.map((probs,s)=>({state:states[s],actionProbabilities:Object.fromEntries(actions.map((a,i)=>[a,probs[i]]))}))})),note:'Causal action effects are assumed known in the supplied MDP. Rewards can be nonidentifiable under feature symmetries; no causal discovery from demonstrations.'};
}
