import test from 'node:test';
import assert from 'node:assert/strict';
import {filterGaussNemesis96} from '../kalman-96.mjs';

const close=(a,b,label,tolerance=2e-9)=>assert.ok(
  Math.abs(a-b)<=tolerance*Math.max(1,Math.abs(a),Math.abs(b)),`${label}: ${a} != ${b}`);

test('96 independently matches analytic scalar Kalman over 64 deterministic time-varying scenarios',()=>{
  let seed=0x7f04ab18;
  const uniform=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/0x100000000;};
  for(let trial=0;trial<64;trial++){
    let mean=(uniform()-.5)*8, variance=.05+uniform()*4, ll=0;
    const firstMean=mean, firstFactor=Math.sqrt(variance), steps=[];
    for(let tick=0;tick<12;tick++){
      const F=.2+uniform()*1.7, q=uniform()*.7, H=.3+uniform()*1.9;
      const r=.05+uniform()*.9,offset=(uniform()-.5)*2;
      const missing=(trial+tick)%7===0;
      const y=missing?null:(uniform()-.5)*12;
      steps.push({transition:[[F]],processFactor:[[q]],observationMatrix:[[H]],
        observationFactor:[[r]],observation:[y],offset:[offset]});
      const out=filterGaussNemesis96({initialMean:[firstMean],initialFactor:[[firstFactor]],steps});
      mean=F*mean+offset;variance=F*F*variance+q*q;
      if(!missing){
        const residual=y-H*mean, innovation=H*H*variance+r*r;
        const gain=variance*H/innovation;
        mean+=gain*residual;
        variance=variance*r*r/innovation;
        ll-=.5*(Math.log(2*Math.PI*innovation)+residual*residual/innovation);
      }
      close(out.mean[0],mean,`trial ${trial} tick ${tick} mean`);
      close(out.factor[0][0]**2,variance,`trial ${trial} tick ${tick} variance`);
      close(out.logLikelihood,ll,`trial ${trial} tick ${tick} likelihood`);
      assert.equal(out.history[tick].innovationRank,missing?0:1);
    }
  }
});

test('96 consistent deterministic scalar measurement collapses variance without jitter',()=>{
  const out=filterGaussNemesis96({initialMean:[1],initialFactor:[[3]],steps:[
    {transition:[[1]],processFactor:[[0]],observationMatrix:[[1]],observationFactor:[[0]],observation:[5]},
    {transition:[[1]],processFactor:[[0]],observationMatrix:[[1]],observationFactor:[[0]],observation:[5]}
  ]});
  close(out.mean[0],5,'deterministic mean');close(out.factor[0][0],0,'deterministic factor');
  assert.deepEqual(out.history.map(s=>s.innovationRank),[1,0]);
});
