import {object,array,number} from './shared.mjs';
import {vector} from './numerics.mjs';
/** Directional KL and symmetric Jensen-Shannon divergence on the finite probability simplex. */
export function analyzeInformationGeometry(input){
 object(input,'geometry',['p','q']);
 const p=vector(input.p,'p',2,128),q=vector(input.q,'q',p.length,p.length);
 for(const [name,v] of [['p',p],['q',q]]){
  if(v.some(x=>x<0))throw new TypeError(`${name} probabilities must be nonnegative`);
  if(Math.abs(v.reduce((a,b)=>a+b,0)-1)>1e-10)throw new TypeError(`${name} probabilities must sum to one`);
 }
 const kl=(a,b)=>a.reduce((s,v,i)=>s+(v===0?0:b[i]===0?Infinity:v*Math.log(v/b[i])),0);
 const m=p.map((v,i)=>(v+q[i])/2),kPQ=kl(p,q),kQP=kl(q,p),js=(kl(p,m)+kl(q,m))/2;
 const tv=p.reduce((s,v,i)=>s+Math.abs(v-q[i]),0)/2;
 return {domain:'FINITE_PROBABILITY_SIMPLEX',klPtoQ:kPQ===Infinity?'Infinity':kPQ,klQtoP:kQP===Infinity?'Infinity':kQP,jensenShannonNats:js,totalVariation:tv,identical:tv===0,note:'KL is directional and can be infinite. This finite-simplex computation does not construct a general non-Riemannian geometry.'};
}
