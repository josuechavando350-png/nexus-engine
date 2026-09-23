import {object,integer,number} from './shared.mjs';
import {vector} from './numerics.mjs';
/** Lorenz-96 autonomous ODE, classical RK4 and paired-trajectory finite-time exponent estimate. */
export function simulateLorenz96(input){
 object(input,'lorenz96',['initial','forcing','dt','steps','sampleEvery','perturbation'],['initial','forcing','dt','steps']);
 const x=vector(input.initial,'initial',4,128),N=x.length,F=number(input.forcing,'forcing',-100,100);
 const dt=number(input.dt,'dt',1e-7,0.05),steps=integer(input.steps,'steps',1,20000);
 const every=integer(input.sampleEvery??Math.max(1,Math.floor(steps/100)),'sampleEvery',1,steps);
 const eps=number(input.perturbation??1e-7,'perturbation',1e-12,1e-3);
 const deriv=v=>v.map((z,i)=>(v[(i+1)%N]-v[(i+N-2)%N])*v[(i+N-1)%N]-z+F);
 const advance=v=>{
  const k1=deriv(v),k2=deriv(v.map((z,i)=>z+dt*k1[i]/2)),k3=deriv(v.map((z,i)=>z+dt*k2[i]/2)),k4=deriv(v.map((z,i)=>z+dt*k3[i]));
  return v.map((z,i)=>z+dt*(k1[i]+2*k2[i]+2*k3[i]+k4[i])/6);
 };
 let current=[...x],near=[...x];near[0]+=eps;let logStretch=0;
 const trace=[{step:0,time:0,state:[...current]}];
 for(let t=1;t<=steps;t++){
  current=advance(current);near=advance(near);
  if(current.some(z=>!Number.isFinite(z))||near.some(z=>!Number.isFinite(z)))throw new RangeError('trajectory diverged; reduce dt');
  const dist=Math.hypot(...near.map((z,i)=>z-current[i]));
  if(!(dist>0)&&dist!==0)throw new RangeError('invalid distance');
  if(dist===0)throw new RangeError('paired trajectory collapsed below floating-point precision');
  logStretch+=Math.log(dist/eps);
  near=near.map((z,i)=>current[i]+(z-current[i])*eps/dist);
  if(t%every===0||t===steps)trace.push({step:t,time:t*dt,state:[...current]});
 }
 return {model:'LORENZ_96',dimension:N,forcing:F,dt,steps,finalState:current,finiteTimeLyapunovEstimate:logStretch/(steps*dt),samples:trace,note:'Numerical finite-time separation estimate with one tangent direction, not a certified Lyapunov exponent or invariant attractor proof.'};
}
