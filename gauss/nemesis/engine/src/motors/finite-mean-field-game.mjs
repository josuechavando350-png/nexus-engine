import {object,array,vector,matrix,prob,number,integer} from './finite-tools.mjs';
/** Finite-horizon 2-state mean-field congestion game by damped best-response iteration. */
export function solveFiniteMeanFieldGame(input){object(input,'mean field game',['initial','transitions','costs','congestion','terminal','horizon','iterations','damping','tolerance'],['initial','transitions','costs','congestion','horizon']);
 const initial=prob(input.initial,'initial',2),transitions=array(input.transitions,'transitions',2,2),A=array(transitions[0],'transitions[0]',1,16).length;
 const P=transitions.map((actions,s)=>array(actions,`transitions[${s}]`,A,A).map((row,a)=>prob(row,`transitions[${s}][${a}]`,2)));
 const costs=matrix(input.costs,'costs',2,A),congestion=vector(input.congestion,'congestion',2,2),terminal=input.terminal?vector(input.terminal,'terminal',2,2):[0,0];
 const horizon=integer(input.horizon,'horizon',1,64),iterations=integer(input.iterations??200,'iterations',1,10000),damping=number(input.damping??.5,'damping',1e-6,1),tol=number(input.tolerance??1e-8,'tolerance',1e-12,.1);
 let flow=Array.from({length:horizon+1},()=>initial.slice()),policy=[],residual=Infinity,used=0;
 for(let k=0;k<iterations;k++){const V=Array.from({length:horizon+1},()=>[0,0]);V[horizon]=terminal.slice();const newPolicy=Array.from({length:horizon},()=>[0,0]);
  for(let t=horizon-1;t>=0;t--)for(let s=0;s<2;s++){let best=Infinity,aBest=0;for(let a=0;a<A;a++){const v=costs[s][a]+congestion[s]*flow[t][s]+P[s][a].reduce((sum,p,j)=>sum+p*V[t+1][j],0);if(v<best-1e-12){best=v;aBest=a;}}V[t][s]=best;newPolicy[t][s]=aBest;}
  const next=[initial.slice()];for(let t=0;t<horizon;t++){const r=[0,0];for(let s=0;s<2;s++)for(let j=0;j<2;j++)r[j]+=next[t][s]*P[s][newPolicy[t][s]][j];next.push(r);}
  residual=Math.max(...next.flatMap((r,t)=>r.map((v,s)=>Math.abs(v-flow[t][s]))));flow=next.map((r,t)=>r.map((v,s)=>t===0?v:flow[t][s]*(1-damping)+v*damping));policy=newPolicy;used=k+1;if(residual<tol)break;
 }
 // Re-evaluate the final reported policy against the final mean-field path.
 const final=[initial.slice()];for(let t=0;t<horizon;t++){const r=[0,0];for(let s=0;s<2;s++)for(let j=0;j<2;j++)r[j]+=final[t][s]*P[s][policy[t][s]][j];final.push(r);}
 const consistency=Math.max(...final.flatMap((r,t)=>r.map((v,s)=>Math.abs(v-flow[t][s]))));
 const V=Array.from({length:horizon+1},()=>[0,0]);V[horizon]=terminal.slice();let policyOptimal=true;
 for(let t=horizon-1;t>=0;t--)for(let st=0;st<2;st++){const alternatives=P[st].map((row,a)=>costs[st][a]+congestion[st]*flow[t][st]+row.reduce((z,p,j)=>z+p*V[t+1][j],0));
   const optimum=Math.min(...alternatives);if(alternatives[policy[t][st]]>optimum+tol)policyOptimal=false;V[t][st]=optimum;}

 return {domain:'TWO_STATE_FINITE_HORIZON_MEAN_FIELD_GAME',status:consistency<tol&&policyOptimal?'CONVERGED':'NOT_CONVERGED',policy,distribution:flow,consistencyResidual:consistency,policyOptimal,iterations:used,note:'Damped fixed-point best response for an explicitly provided two-state congestion game; nonconvergence is reported, not suppressed.'};
}
