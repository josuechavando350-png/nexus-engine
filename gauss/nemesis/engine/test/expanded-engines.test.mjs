import test from 'node:test';
import assert from 'node:assert/strict';
import {runMotor,evaluateMultivariateHawkes,fitMultivariateHawkes,simulateMultivariateHawkes,inferGraphCRF,trainGraphCRF,graphCRFLoss,simulateFinitePopulationGame,finitePopulationMoments} from '../src/index.mjs';
const close=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<=t,`${a} vs ${b}`);
const p={baseline:[.7,.4],alpha:[[.3,.2],[.1,.4]],beta:1.2};
const events=[{time:.2,type:0},{time:.8,type:1},{time:1.7,type:0},{time:2.1,type:1}];
const horizon=3;
test('87 multivariate likelihood agrees with independent pairwise event oracle',()=>{
 const r=evaluateMultivariateHawkes({parameters:p,events,horizon});
 const lambda=events.map((e,i)=>p.baseline[e.type]+events.slice(0,i).reduce((s,f)=>s+p.alpha[e.type][f.type]*Math.exp(-p.beta*(e.time-f.time)),0));
 const compensator=p.baseline.reduce((s,v)=>s+v*horizon,0)+events.reduce((s,e)=>s+p.alpha.reduce((q,row)=>q+row[e.type],0)/p.beta*(1-Math.exp(-p.beta*(horizon-e.time))),0);
 close(r.logLikelihood,lambda.reduce((s,v)=>s+Math.log(v),0)-compensator);
 r.eventIntensities.forEach((v,i)=>close(v,lambda[i]));
});
test('87 analytic gradient agrees with central differences including beta',()=>{
 const flat=[...p.baseline,...p.alpha.flat(),p.beta],unflat=x=>({baseline:x.slice(0,2),alpha:[x.slice(2,4),x.slice(4,6)],beta:x[6]});
 const r=evaluateMultivariateHawkes({parameters:p,events,horizon});
 for(let j=0;j<flat.length;j++){const a=[...flat],b=[...flat],h=1e-5;a[j]+=h;b[j]-=h;const f=x=>evaluateMultivariateHawkes({parameters:unflat(x),events,horizon}).logLikelihood;close(r.gradient[j],(f(a)-f(b))/(2*h),1e-7);}
});
test('87 parameter fitting converges for fixed kernel and improves log likelihood',()=>{
 const sample=simulateMultivariateHawkes({parameters:{baseline:[1],alpha:[[.4]],beta:1},horizon:100,seed:333});
 const initial={baseline:[.1],alpha:[[.1]],beta:1};
 const r=fitMultivariateHawkes({events:sample.events,horizon:100,initial,fitBeta:false,iterations:5000,tolerance:1e-7});
 assert.equal(r.status,'CONVERGED');assert.ok(r.logLikelihood>evaluateMultivariateHawkes({parameters:initial,events:sample.events,horizon:100}).logLikelihood+10);
 assert.equal(r.parameters.beta,1);assert.ok(r.optimization.history.every((v,i,a)=>!i||v<=a[i-1]+1e-12));
});
test('87 free beta gradient fit, explicit nonconvergence and uncertainty contract',()=>{
 const r=fitMultivariateHawkes({events,horizon,initial:p,iterations:1});
 assert.ok(['ITERATION_LIMIT','CONVERGED'].includes(r.status));assert.ok(r.logLikelihood>=evaluateMultivariateHawkes({parameters:p,events,horizon}).logLikelihood-1e-8);
 if(r.status!=='CONVERGED')assert.equal(r.uncertainty.available,false);
});
test('87 zero excitation simulation matches independent Poisson moments',()=>{
 const counts=Array.from({length:1000},(_,seed)=>simulateMultivariateHawkes({parameters:{baseline:[2],alpha:[[0]],beta:1},horizon:10,seed}).events.length);
 const mean=counts.reduce((s,v)=>s+v,0)/counts.length;close(mean,20,.6);
 close(counts.reduce((s,v)=>s+(v-mean)**2,0)/(counts.length-1),20,2.5);
});
test('87 simulation reproducible, sorted, bounded and rejects incomplete runs',()=>{
 const spec={parameters:p,horizon:30,seed:72};assert.deepEqual(simulateMultivariateHawkes(spec),simulateMultivariateHawkes(spec));
 const r=simulateMultivariateHawkes(spec);assert.ok(r.events.every((e,i)=>e.time<30&&(!i||e.time>r.events[i-1].time)));
 assert.throws(()=>simulateMultivariateHawkes({...spec,maxEvents:1}),/maxEvents/);
 assert.throws(()=>evaluateMultivariateHawkes({parameters:p,events:[events[0],events[0]],horizon}),/increasing/);
 assert.throws(()=>fitMultivariateHawkes({initial:p,events:[],horizon}),/requires events/);
});
const graph={variables:[2,2,2],factors:[{scope:[0,1],features:[[1,0],[0,1],[0,1],[1,0]]},{scope:[1,2],features:[[1,0],[0,1],[0,1],[1,0]]},{scope:[2,0],features:[[1,0],[0,1],[0,1],[1,0]]}]};
test('49 cyclic graph inference agrees with independent eight-assignment oracle',()=>{
 const w=[.7,-.2],r=inferGraphCRF({graph,weights:w});let z=0,ex=[0,0];const marg=Array.from({length:3},()=>[0,0]);
 for(let k=0;k<8;k++){const y=[k&1,(k>>1)&1,(k>>2)&1];let equal=0;for(let i=0;i<3;i++)equal+=+(y[i]===y[(i+1)%3]);const phi=[equal,3-equal],mass=Math.exp(phi[0]*w[0]+phi[1]*w[1]);z+=mass;phi.forEach((v,j)=>ex[j]+=v*mass);y.forEach((v,j)=>marg[j][v]+=mass);}
 close(r.logPartition,Math.log(z));r.expectedFeatures.forEach((v,j)=>close(v,ex[j]/z));r.marginals.forEach((row,i)=>row.forEach((v,j)=>close(v,marg[i][j]/z)));
 assert.deepEqual(r.mapLabels,[0,0,0]);
});
test('99 learned-factor gradient matches numerical differentiation',()=>{
 const input={examples:[{graph,labels:[0,0,1]},{graph,labels:[1,1,1]}],initialWeights:[.4,-.2],l2:.03},r=graphCRFLoss(input);
 for(let i=0;i<2;i++){const a=structuredClone(input),b=structuredClone(input);a.initialWeights[i]+=1e-5;b.initialWeights[i]-=1e-5;close(r.gradient[i],(graphCRFLoss(a).value-graphCRFLoss(b).value)/2e-5,1e-7);}
});
test('49/99 train graph potentials, recover known Bernoulli odds and preserve legacy paths',()=>{
 const independent={variables:[2],factors:[{scope:[0],features:[[0],[1]]}]};
 const examples=Array.from({length:10},(_,i)=>({graph:independent,labels:[i<8?1:0]}));
 const fit=trainGraphCRF({examples,initialWeights:[0],l2:0,iterations:1000,tolerance:1e-9});assert.equal(fit.status,'CONVERGED');close(fit.weights[0],Math.log(4),1e-7);
 for(const id of ['49','99']){const r=runMotor(id,{action:'inferGraph',payload:{graph:independent,weights:fit.weights}});close(r.marginals[0][1],.8,1e-8);}
 assert.ok(runMotor('49',{unary:[[0,0]],transition:[[0,0],[0,0]]}).marginals);
});
test('49 arbitrary high-order factors, disconnected graph, huge scores and invalid inputs',()=>{
 const r=inferGraphCRF({graph:{variables:[2,2,2],factors:[{scope:[2,0,1],features:Array.from({length:8},(_,i)=>[i===7?1:0])}]},weights:[10000]});close(r.logPartition,10000);assert.deepEqual(r.mapLabels,[1,1,1]);
 assert.throws(()=>inferGraphCRF({graph:{variables:Array(20).fill(2),factors:graph.factors},weights:[0,0]}),/budget/);
 assert.throws(()=>inferGraphCRF({graph:{variables:[2,2],factors:[{scope:[0,0],features:[[0],[0],[0],[0]]}]},weights:[1]}),/duplicates/);
 assert.throws(()=>runMotor('99',{action:'unknown',payload:{}}),/unsupported/);
});
const population={counts:[10,10],payoffs:[[0,0],[0,0]],mutation:[[1,0],[0,1]],selection:0};
test('68 finite population sampling agrees with exact multinomial first and second moments',()=>{
 const expected=finitePopulationMoments(population),r=simulateFinitePopulationGame({...population,generations:1,replicates:5000,seed:909});
 close(r.meanFinalCounts[0],expected.expectedCounts[0],.15);close(r.sampleCovariance[0][0],expected.covariance[0][0],.3);close(r.sampleCovariance[0][1],expected.covariance[0][1],.3);
 assert.ok(r.trajectories.every(h=>h.every(c=>c.every(Number.isInteger)&&c.reduce((s,v)=>s+v,0)===20)));
 assert.ok(new Set(r.trajectories.map(h=>h[1][0])).size>5);
});
test('68 absorbing fixation, mutation, seed replay and work limits',()=>{
 const spec={...population,counts:[20,0],generations:10,seed:15};const r=simulateFinitePopulationGame(spec);assert.ok(r.trajectories[0].every(c=>c[0]===20));assert.deepEqual(r,simulateFinitePopulationGame(spec));
 const mutate=simulateFinitePopulationGame({...spec,mutation:[[0,1],[1,0]],generations:1});assert.deepEqual(mutate.trajectories[0][1],[0,20]);
 assert.throws(()=>simulateFinitePopulationGame({...spec,replicates:10000,generations:10000}),/budget/);
 assert.deepEqual(runMotor('68',{action:'moments',payload:population}),finitePopulationMoments(population));
});
