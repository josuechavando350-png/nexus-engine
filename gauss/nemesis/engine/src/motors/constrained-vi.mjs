import {object,array,number,integer,prob,assertFinite} from './finite-tools.mjs';
/** I-projection onto one explicitly provided expectation constraint. */
export function constrainedCategoricalVI(input){
 object(input,'vi',['prior','feature','target','iterations','tolerance'],['prior','feature','target']);const prior=array(input.prior,'prior',2,128),n=prior.length;prob(prior,'prior',n);if(prior.some(x=>x<=0))throw new TypeError('strictly positive prior required');
 const f=array(input.feature,'feature',n,n).map((v,i)=>number(v,`feature[${i}]`,-100,100)),target=number(input.target,'target',Math.min(...f),Math.max(...f));
 const iterations=integer(input.iterations??180,'iterations',1,300),tol=number(input.tolerance??1e-9,'tolerance',1e-14,1e-2);
 function distribution(lambda){const log=prior.map((p,i)=>Math.log(p)+lambda*f[i]),mx=Math.max(...log),raw=log.map(x=>Math.exp(x-mx)),z=raw.reduce((a,b)=>a+b,0),q=raw.map(x=>x/z);return {q,expectation:q.reduce((s,v,i)=>s+v*f[i],0)};}
 let lo=-1,hi=1;for(let k=0;k<100&&distribution(lo).expectation>target;k++)lo*=2;for(let k=0;k<100&&distribution(hi).expectation<target;k++)hi*=2;
 let lambda=0,out=distribution(lambda),used=0;for(;used<iterations;used++){lambda=(lo+hi)/2;out=distribution(lambda);if(Math.abs(out.expectation-target)<=tol)break;if(out.expectation<target)lo=lambda;else hi=lambda;}
 const feasible=Math.abs(out.expectation-target)<=tol;
 return {domain:'CATEGORICAL_KL_IPROJECTION_ONE_MOMENT',status:feasible?'CONVERGED':'NOT_CONVERGED',posterior:out.q,dual:lambda,expectedFeature:out.expectation,target,kl:assertFinite(out.q.reduce((s,q,i)=>s+(q?q*Math.log(q/prior[i]):0),0)),iterations:Math.min(used+1,iterations),note:'Known prior and a single linear equality constraint; no inference of causal-economic structure.'};
}
