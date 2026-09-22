import {object,array,number} from './finite-tools.mjs';
export function fisherRaoGeometry(input){
 object(input,'fisher',['p','q'],['p','q']);const p=array(input.p,'p',2,128),q=array(input.q,'q',p.length,p.length);
 for(const [name,dist] of [['p',p],['q',q]]){dist.forEach((v,i)=>number(v,`${name}[${i}]`,0,1));if(Math.abs(dist.reduce((s,v)=>s+v,0)-1)>1e-10)throw new TypeError(`${name} probabilities sum`);}
 const bc=p.reduce((s,v,i)=>s+Math.sqrt(v*q[i]),0);const distance=2*Math.acos(Math.max(-1,Math.min(1,bc)));
 const metric=p.every(x=>x>0)?p.slice(0,-1).map((v,i)=>p.slice(0,-1).map((_,j)=>+(i===j)/v+1/p.at(-1))):null;
 return {domain:'CATEGORICAL_SIMPLEX_FISHER_RAO',distance,hellingerSquared:Math.max(0,1-bc),metricChart:metric,dimension:p.length-1,note:'Exact Fisher-Rao geodesic on probability simplex; metric chart undefined at boundary.'};
}
