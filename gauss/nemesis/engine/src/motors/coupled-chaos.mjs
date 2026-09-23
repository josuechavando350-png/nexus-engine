import {object,vector,number,integer,assertFinite} from './finite-tools.mjs';
export function simulateCoupledLogisticLattice(input){
 object(input,'lattice',['initial','r','coupling','steps','sampleEvery'],['initial','r','coupling','steps']);const x=vector(input.initial,'initial',3,256),n=x.length;x.forEach((v,i)=>number(v,`initial[${i}]`,0,1));const r=number(input.r,'r',0,4),c=number(input.coupling,'coupling',0,1),steps=integer(input.steps,'steps',1,50000),stride=integer(input.sampleEvery??Math.max(1,Math.floor(steps/64)),'sampleEvery',1,steps);
 let state=x.slice(),tangent=Array.from({length:n},()=>1/Math.sqrt(n)),lyap=0,trajectory=[];
 for(let t=0;t<steps;t++){const f=state.map(v=>r*v*(1-v)),d=state.map(v=>r*(1-2*v));let next=[],vnext=[];
 for(let i=0;i<n;i++){const left=(i+n-1)%n,right=(i+1)%n;next[i]=(1-c)*f[i]+c*(f[left]+f[right])/2;vnext[i]=(1-c)*d[i]*tangent[i]+c*(d[left]*tangent[left]+d[right]*tangent[right])/2;}
 const norm=Math.hypot(...vnext);if(norm===0){lyap=-Infinity;tangent=Array.from({length:n},(_,i)=>+(i===0));}else{if(lyap!==-Infinity)lyap+=Math.log(norm);tangent=vnext.map(v=>v/norm);}
 state=next; if(state.some(v=>!Number.isFinite(v)))throw new RangeError('diverged lattice');if(t%stride===0||t===steps-1)trajectory.push(state.slice());
 }
 return {domain:'COUPLED_LOGISTIC_MAP_LATTICE',final:state,trajectory,largestLyapunovEstimate:lyap===-Infinity?'-Infinity':assertFinite(lyap/steps),steps,note:'Finite-time tangent growth of a particular initial condition; no proof of global strange attractor.'};
}
