import {object,array,id,unique,integer,number} from './shared.mjs';
/** Finite horizon discounted stochastic control with exhaustive Bellman backups. */
export function solveStochasticDP(input){
 object(input,'mdp',['states','actions','transitions','rewards','horizon','discount','terminal'],['states','actions','transitions','rewards','horizon']);
 const states=unique(array(input.states,'states',1,64).map(v=>id(v,'state')),'states');
 const actions=unique(array(input.actions,'actions',1,32).map(v=>id(v,'action')),'actions');
 const n=states.length,m=actions.length,horizon=integer(input.horizon,'horizon',1,200),discount=number(input.discount??1,'discount',0,1);
 const transitions=array(input.transitions,'transitions',n,n).map((byAction,i)=>array(byAction,`transitions[${i}]`,m,m).map((row,j)=>{
  const p=array(row,`transitions[${i}][${j}]`,n,n).map((v,k)=>number(v,`p${k}`,0,1));
  if(Math.abs(p.reduce((s,v)=>s+v,0)-1)>1e-10)throw new TypeError('transition row sum');return p;
 }));
 const rewards=array(input.rewards,'rewards',n,n).map((r,i)=>array(r,`rewards[${i}]`,m,m).map((v,j)=>number(v,`reward[${i}][${j}]`,-1e9,1e9)));
 let value=(input.terminal===undefined?Array(n).fill(0):array(input.terminal,'terminal',n,n).map((v,i)=>number(v,`terminal[${i}]`,-1e9,1e9)));
 const values=[value],policies=[];
 for(let t=horizon-1;t>=0;t--){const next=[],policy=[];for(let s=0;s<n;s++){
  let best=-Infinity,bestAction=0;
  for(let a=0;a<m;a++){const candidate=rewards[s][a]+discount*transitions[s][a].reduce((acc,p,j)=>acc+p*value[j],0);if(candidate>best){best=candidate;bestAction=a;}}
  if(!Number.isFinite(best))throw new RangeError('Bellman overflow');next.push(best);policy.push(actions[bestAction]);
 }value=next;values.unshift(next);policies.unshift(policy);}
 return {domain:'FINITE_HORIZON_STOCHASTIC_DP',states,values,policies,discount,horizon,note:'Known tabular dynamics; finite horizon; not a model-free reinforcement learner.'};
}
