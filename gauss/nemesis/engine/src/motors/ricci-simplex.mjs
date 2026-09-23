import {object,array,number} from './finite-tools.mjs';
/** Probability simplex Fisher metric has sectional curvature 1/4 (sphere radius 2). */
export function ricciCategoricalSimplex(input){object(input,'ricci',['p']);const p=array(input.p,'p',2,32);p.forEach((v,i)=>number(v,`p[${i}]`,Number.EPSILON,1));if(Math.abs(p.reduce((a,b)=>a+b,0)-1)>1e-10)throw new TypeError('simplex probabilities must sum to 1');
 const d=p.length-1,q=p[d],metric=Array.from({length:d},(_,i)=>Array.from({length:d},(_,j)=>(i===j?1/p[i]:0)+1/q)),ricci=metric.map(row=>row.map(v=>v*(d-1)/4));
 return {domain:'CATEGORICAL_FISHER_RAO_RICCI',dimension:d,metric,ricci,scalarCurvature:d*(d-1)/4,sectionalCurvature:d===1?null:.25,note:'Analytic curvature tensor contraction of interior categorical simplex only; no arbitrary learned information manifold.'};}
