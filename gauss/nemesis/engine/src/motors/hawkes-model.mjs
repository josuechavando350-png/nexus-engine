import {object,array,number,integer} from './shared.mjs';
import {matrix,vector,seeded,solveLinear,cholesky} from './numerics.mjs';
import {minimizeBox} from '../learning/box-optimizer.mjs';
const sum=a=>a.reduce((s,v)=>s+v,0);
function parameters(raw){
  object(raw,'parameters',['baseline','alpha','beta']);
  const baseline=vector(raw.baseline,'baseline',1,8).map(v=>number(v,'baseline',1e-8,1e6)),d=baseline.length;
  const alpha=matrix(raw.alpha,'alpha',d,d).map(r=>r.map(v=>number(v,'alpha',0,1e6)));
  return {baseline,alpha,beta:number(raw.beta,'beta',1e-6,1e6)};
}
function observations(events,horizon,d){
  number(horizon,'horizon',1e-6,1e8);
  return array(events,'events',0,10000).map((e,i)=>{
    object(e,'event',['time','type']);
    const time=number(e.time,'event time',0,horizon),type=integer(e.type,'event type',0,d-1);
    if(time>=horizon||(i&&time<=events[i-1].time))throw new TypeError('events must have strictly increasing times below horizon');
    return {time,type};
  });
}
const flatten=p=>[...p.baseline,...p.alpha.flat(),p.beta];
const unflatten=(x,d)=>({baseline:x.slice(0,d),alpha:Array.from({length:d},(_,i)=>x.slice(d+i*d,d+(i+1)*d)),beta:x.at(-1)});
/** lambda_i(t)=mu_i+sum_j alpha_ij sum_{s in N_j,s<t} exp(-beta(t-s)); empty prehistory. */
function calculate(p,events,T){
  const {baseline:mu,alpha,beta}=p,d=mu.length,shot=Array(d).fill(0),derivative=Array(d).fill(0);
  const gradient=Array(d+d*d+1).fill(0),intensities=[];
  let previous=0,ll=0;
  for(const e of events){
    const dt=e.time-previous,decay=Math.exp(-beta*dt);
    for(let j=0;j<d;j++){derivative[j]=decay*(derivative[j]-dt*shot[j]);shot[j]*=decay;}
    const lambda=mu[e.type]+sum(alpha[e.type].map((v,j)=>v*shot[j]));
    intensities.push(lambda);ll+=Math.log(lambda);gradient[e.type]+=1/lambda;
    for(let j=0;j<d;j++)gradient[d+e.type*d+j]+=shot[j]/lambda;
    gradient[gradient.length-1]+=sum(alpha[e.type].map((v,j)=>v*derivative[j]))/lambda;
    shot[e.type]++;previous=e.time;
  }
  const compensator=mu.map(v=>v*T),integrals=Array(d).fill(0),dIntegrals=Array(d).fill(0);
  for(const e of events){const lag=T-e.time,z=beta*lag,em=Math.exp(-z);
    integrals[e.type]+=-Math.expm1(-z)/beta;
    // Stable series near zero avoids cancellation of e^-z (1+z)-1.
    dIntegrals[e.type]+=z<1e-4?lag*lag*(-.5+z/3-z*z/8+z*z*z/30):(em*(z+1)-1)/(beta*beta);
  }
  for(let i=0;i<d;i++){
    gradient[i]-=T;
    for(let j=0;j<d;j++){compensator[i]+=alpha[i][j]*integrals[j];gradient[d+i*d+j]-=integrals[j];gradient[gradient.length-1]-=alpha[i][j]*dIntegrals[j];}
  }
  ll-=sum(compensator);
  return {logLikelihood:ll,gradient,eventIntensities:intensities,compensatorByType:compensator};
}
export function evaluateMultivariateHawkes(input){
  object(input,'Hawkes evaluation',['parameters','events','horizon']);const p=parameters(input.parameters),events=observations(input.events,input.horizon,p.baseline.length);
  const rowBound=Math.max(...p.alpha.map(r=>sum(r)/p.beta));
  return {domain:'MULTIVARIATE_EXPONENTIAL_HAWKES',...calculate(p,events,input.horizon),parameters:p,branchingRowSumBound:rowBound,stationaritySufficientCondition:rowBound<1,prehistory:'empty',parameterOrder:'baseline, row-major alpha, beta'};
}
export function fitMultivariateHawkes(input){
  object(input,'Hawkes fit',['events','horizon','initial','fitBeta','iterations','tolerance','l2'],['events','horizon','initial']);
  const p=parameters(input.initial),d=p.baseline.length,events=observations(input.events,input.horizon,d);
  if(!events.length)throw new TypeError('fitting requires events; an empty interval cannot identify an excitation kernel');
  if(input.fitBeta!==undefined&&typeof input.fitBeta!=='boolean')throw new TypeError('fitBeta must be boolean');
  const fitBeta=input.fitBeta??true,l2=number(input.l2??0,'l2',0,100),x=flatten(p),lower=x.map((_,i)=>i<d?1e-8:i===x.length-1?1e-6:0),upper=x.map(()=>1e6);
  if(!fitBeta)lower[lower.length-1]=upper[upper.length-1]=p.beta;
  const evaluate=x=>{const r=calculate(unflatten(x,d),events,input.horizon);return {value:-r.logLikelihood/events.length+l2*sum(x.slice(0,-1).map(v=>v*v))/2,gradient:r.gradient.map((v,i)=>-v/events.length+(i<x.length-1?l2*x[i]:0))};};
  const fit=minimizeBox(evaluate,x,lower,upper,{iterations:integer(input.iterations??2000,'iterations',1,20000),tolerance:number(input.tolerance??1e-7,'tolerance',1e-12,.1)});
  const learned=unflatten(fit.parameters,d),evaluation=evaluateMultivariateHawkes({parameters:learned,events,horizon:input.horizon});
  // Observed information only for interior, unpenalized estimates. Boundary normal CIs are invalid.
  let uncertainty={available:false,reason:'estimate is at a constraint boundary or regularized'};
  const active=fitBeta?x.length:x.length-1;
  if(fit.status==='CONVERGED'&&l2===0&&fit.parameters.slice(0,active).every((v,i)=>v>lower[i]+1e-5&&v<upper[i]-1e-5)){
    try{
      const hessian=Array.from({length:active},()=>Array(active).fill(0));
      for(let j=0;j<active;j++){
        const h=Math.min(1e-4*Math.max(1,Math.abs(fit.parameters[j])),(fit.parameters[j]-lower[j])/2),plus=[...fit.parameters],minus=[...fit.parameters];plus[j]+=h;minus[j]-=h;
        const gp=calculate(unflatten(plus,d),events,input.horizon).gradient,gm=calculate(unflatten(minus,d),events,input.horizon).gradient;
        for(let i=0;i<active;i++)hessian[i][j]=-(gp[i]-gm[i])/(2*h);
      }
      for(let i=0;i<active;i++)for(let j=0;j<i;j++)hessian[i][j]=hessian[j][i]=(hessian[i][j]+hessian[j][i])/2;
      cholesky(hessian);
      const cols=Array.from({length:active},(_,j)=>solveLinear(hessian,Array.from({length:active},(_,i)=>+(i===j))));
      const covariance=cols.map((_,i)=>cols.map(c=>c[i]));
      uncertainty={available:true,method:'asymptotic observed information; conditional on beta when fixed',covariance,standardErrors:covariance.map((r,i)=>Math.sqrt(r[i]))};
    }catch{uncertainty={available:false,reason:'observed information singular or not positive definite'};}
  }else if(fit.status!=='CONVERGED')uncertainty={available:false,reason:'optimizer has not converged'};
  return {...evaluation,status:fit.status,optimization:fit,uncertainty,fitBeta,globalOptimumGuaranteed:false};
}
export function simulateMultivariateHawkes(input){
  object(input,'Hawkes simulation',['parameters','horizon','seed','maxEvents','maxCandidates'],['parameters','horizon','seed']);
  const p=parameters(input.parameters),T=number(input.horizon,'horizon',1e-6,1e8),rng=seeded(integer(input.seed,'seed',0,2**32-1)),maxEvents=integer(input.maxEvents??10000,'maxEvents',1,10000),maxCandidates=integer(input.maxCandidates??100000,'maxCandidates',1,1000000),d=p.baseline.length,shot=Array(d).fill(0),events=[];
  const rates=()=>p.baseline.map((v,i)=>v+sum(p.alpha[i].map((a,j)=>a*shot[j])));
  let t=0;
  for(let c=0;c<maxCandidates;c++){
    const bound=sum(rates()),dt=-Math.log(rng())/bound,previousTime=t;t+=dt;
    if(t>=T)return {domain:'MULTIVARIATE_EXPONENTIAL_HAWKES_SIMULATION',events,horizon:T,seed:input.seed,candidates:c+1,complete:true};
    if(!Number.isFinite(t)||!(t>previousTime))throw new RangeError('simulation lost time resolution');
    for(let j=0;j<d;j++)shot[j]*=Math.exp(-p.beta*dt);
    const actual=rates(),u=rng()*bound;let cumulative=0;
    for(let j=0;j<d;j++){cumulative+=actual[j];if(u<cumulative){if(events.length===maxEvents)throw new RangeError('Hawkes maxEvents exceeded; simulation incomplete');events.push({time:t,type:j});shot[j]++;break;}}
  }
  throw new RangeError('Hawkes maxCandidates exceeded; simulation incomplete');
}
