import {object,array,id,unique,number} from './shared.mjs';
/** Enumerative robust min-max cost and minimax regret with hard scenario-dependent feasibility. */
export function optimizeScenarioRobust(input){
 object(input,'robust optimization',['decisions','scenarios','objective','feasible'],['decisions','scenarios','objective']);
 const decisions=unique(array(input.decisions,'decisions',1,512).map((v,i)=>id(v,`decisions[${i}]`)),'decisions');
 const scenarios=unique(array(input.scenarios,'scenarios',1,512).map((v,i)=>id(v,`scenarios[${i}]`)),'scenarios');
 const objective=array(input.objective,'objective',decisions.length,decisions.length).map((r,i)=>array(r,`objective[${i}]`,scenarios.length,scenarios.length).map((v,j)=>number(v,`objective[${i}][${j}]`)));
 const feasible=array(input.feasible??decisions.map(()=>scenarios.map(()=>true)),'feasible',decisions.length,decisions.length).map((r,i)=>array(r,`feasible[${i}]`,scenarios.length,scenarios.length).map((v,j)=>{if(typeof v!=='boolean')throw new TypeError(`feasible[${i}][${j}] must be boolean`);return v;}));
 const baselines=scenarios.map((_,j)=>{let best=Infinity;for(let i=0;i<decisions.length;i++)if(feasible[i][j])best=Math.min(best,objective[i][j]);return best;});
 const candidates=decisions.flatMap((decision,i)=>feasible[i].every(Boolean)?[{decision,maximumCost:Math.max(...objective[i]),maximumRegret:Math.max(...objective[i].map((v,j)=>v-baselines[j])),costs:objective[i]}]:[]);
 if(!candidates.length)return {domain:'FINITE_SCENARIO_ROBUST_OPTIMIZATION',status:'INFEASIBLE',feasibleCount:0,minimumMaxCost:null,minimumMaxRegret:null,scenarios,note:'No decision meets all scenario constraints; no fictitious optimizer returned.'};
 const cost=[...candidates].sort((a,b)=>a.maximumCost-b.maximumCost||a.decision.localeCompare(b.decision))[0];
 const regret=[...candidates].sort((a,b)=>a.maximumRegret-b.maximumRegret||a.decision.localeCompare(b.decision))[0];
 return {domain:'FINITE_SCENARIO_ROBUST_OPTIMIZATION',status:'OPTIMAL_FINITE',feasibleCount:candidates.length,minimumMaxCost:cost,minimumMaxRegret:regret,scenarioBestFeasibleCosts:baselines,scenarios,note:'Exhaustive finite candidate enumeration; scenarios and feasibility supplied explicitly, not a continuous robust solver or protection against unmodeled uncertainty.'};
}
