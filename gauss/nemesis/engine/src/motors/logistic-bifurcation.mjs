import {object,array,number,integer} from './finite-tools.mjs';
export function analyzeLogisticBifurcation(input){
 object(input,'bifurcation',['parameters','initial','transient','samples'],['parameters']);const parameters=array(input.parameters,'parameters',1,128).map((v,i)=>number(v,`parameters[${i}]`,0,4));
 const initial=number(input.initial??.371,'initial',0,1),transient=integer(input.transient??1000,'transient',0,100000),samples=integer(input.samples??256,'samples',10,8192);
 return {domain:'LOGISTIC_MAP_PARAMETER_SWEEP',results:parameters.map(r=>{let x=initial,sum=0;const tail=[];for(let t=0;t<transient+samples;t++){
  if(t>=transient){const derivative=Math.abs(r*(1-2*x));sum+=derivative?Math.log(derivative):-Infinity;tail.push(x);}
  x=r*x*(1-x);if(!Number.isFinite(x))throw new RangeError('nonfinite orbit');}
  let period=null;for(let p=1;p<=Math.min(32,Math.floor(samples/2));p++)if(tail.slice(-p).every((v,i)=>Math.abs(v-tail.at(-p*2+i))<1e-8)){period=p;break;}
  return {r,lyapunovEstimate:sum===-Infinity?'-Infinity':sum/samples,periodEstimate:period,orbitTail:tail.slice(-16)};
 }),note:'Finite-time Lyapunov and approximate period estimates; no rigorous global bifurcation or chaotic attractor certification.'};
}
