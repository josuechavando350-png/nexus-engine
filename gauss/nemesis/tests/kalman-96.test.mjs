import test from 'node:test';
import assert from 'node:assert/strict';
import {filterGaussNemesis96} from '../kalman-96.mjs';
import {filterTimeVaryingFactorKalman} from '../engine/src/motors/factor-kalman.mjs';
import {runGaussNemesis} from '../bridge.mjs';

const close=(a,b,t=1e-9)=>assert.ok(Math.abs(a-b)<=t*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
const compare=(a,b)=>{
  a.mean.forEach((v,i)=>close(v,b.mean[i]));
  a.factor.forEach((row,i)=>row.forEach((v,j)=>close(v,b.factor[i][j])));
  close(a.logLikelihood,b.logLikelihood);
};
const initial={initialMean:[0,0],initialFactor:[[1,0],[.3,.8]]};
const steps=[
  {transition:[[1,.2],[0,1]],processFactor:[[.1,0],[0,.2]],observationMatrix:[[1,0],[0,1]],observationFactor:[[.5,0],[.2,.4]],observation:[1,null]},
  {transition:[[1,.4],[0,.9]],processFactor:[[0,0],[0,0]],observationMatrix:[[1,1],[1,-1]],observationFactor:[[.2,0],[.1,.3]],observation:[null,.5]},
  {transition:[[1,0],[0,1]],processFactor:[[.1,0],[0,.1]],observationMatrix:[[1,0]],observationFactor:[[.3]],observation:[null]},
];

test('96 GAUSS route matches independently implemented original QR on full-rank and missing correlated observations',async()=>{
  const payload={...initial,steps};
  const old=filterTimeVaryingFactorKalman(payload),integrated=await runGaussNemesis(96,{action:'filter',payload});
  compare(old,integrated);
  assert.deepEqual(integrated.history.map(h=>h.independentChannels),[[0],[1],[]]);
  const simultaneous={initialMean:[0,0],initialFactor:[[1,0],[0,1]],steps:[
    {transition:[[1,0],[0,1]],processFactor:[[0,0],[0,0]],observationMatrix:[[1,0],[0,1]],observationFactor:[[1,0],[.5,1]],observation:[1,2]}
  ]};
  compare(filterTimeVaryingFactorKalman(simultaneous),await runGaussNemesis('96',{action:'filter',payload:simultaneous}));
});

test('96 duplicate noiseless channels: exact assimilation, rank one, zero posterior variance',async()=>{
  const payload={initialMean:[0],initialFactor:[[1]],steps:[
    {transition:[[1]],processFactor:[[0]],observationMatrix:[[1],[1]],observationFactor:[[0,0],[0,0]],observation:[2,2]},
    {transition:[[1]],processFactor:[[0]],observationMatrix:[[1],[1]],observationFactor:[[0,0],[0,0]],observation:[2,2]}
  ]};
  const out=await runGaussNemesis('96',{action:'filter',payload});
  close(out.mean[0],2);close(out.factor[0][0],0);
  assert.deepEqual(out.history.map(s=>s.innovationRank),[1,0]);
  assert.deepEqual(out.history.map(s=>s.observedChannels),[[0,1],[0,1]]);
  assert.equal(out.history[1].logLikelihood,0);
});

test('96 deterministic contradiction rejects rather than returning a fabricated posterior',()=>{
  const base={initialMean:[0],initialFactor:[[1]],steps:[{transition:[[1]],processFactor:[[0]],observationMatrix:[[1],[1]],observationFactor:[[0,0],[0,0]],observation:[2,3]}]};
  assert.throws(()=>filterGaussNemesis96(base),/inconsistent deterministic observation channel 1/);
  assert.throws(()=>filterGaussNemesis96({...base,initialFactor:[[0]],steps:[{...base.steps[0],observation:[1,1]}]}),/inconsistent deterministic observation/);
});

test('96 rank-deficient correlated noise retains informative difference and handles missing channels',()=>{
  const payload={initialMean:[0],initialFactor:[[1]],steps:[
    {transition:[[1]],processFactor:[[0]],observationMatrix:[[1],[0]],observationFactor:[[1,0],[1,0]],observation:[3,1]},
    {transition:[[1]],processFactor:[[0]],observationMatrix:[[1],[1]],observationFactor:[[1,0],[1,0]],observation:[null,2]}
  ]};
  const out=filterGaussNemesis96(payload);
  close(out.history[0].mean[0],2);close(out.history[0].factor[0][0],0);
  close(out.mean[0],2);
  assert.deepEqual(out.history.map(s=>s.innovationRank),[2,1]);
});

test('96 enforces matrices, work budget, and finite arithmetic',()=>{
  const payload={initialMean:[0],initialFactor:[[1]],steps:[{transition:[[1]],processFactor:[[0]],observationMatrix:[[1]],observationFactor:[[1]],observation:[1]}]};
  assert.throws(()=>filterGaussNemesis96({...payload,initialFactor:[[1,1]]}),/initialFactor/);
  const wide={...payload.steps[0],observationMatrix:Array.from({length:32},()=>[1]),observationFactor:Array.from({length:32},(_,i)=>Array.from({length:32},(_,j)=>i===j?1:0)),observation:Array(32).fill(null)};
  assert.throws(()=>filterGaussNemesis96({...payload,steps:Array(1000).fill(wide)}),/work budget/);
  assert.throws(()=>filterGaussNemesis96({...payload,steps:[{...payload.steps[0],observation:[Infinity]}]}),/invalid finite number/);
});
