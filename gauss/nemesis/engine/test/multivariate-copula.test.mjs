import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateMultivariateClayton,sampleMultivariateClayton,fitMultivariateClayton,calibrateClaytonLowerTail,runMotor} from '../src/index.mjs';
const near=(a,b,t=1e-10)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
test('multivariate Clayton CDF and density agree with direct symbolic formula',()=>{
  const u=[0.3,0.6,0.8],theta=2,S=u.reduce((s,v)=>s+v**-theta,1-u.length),r=evaluateMultivariateClayton({u,theta});
  near(r.cdf,S**(-1/theta));near(r.density,15*u.reduce((p,v)=>p*v**-3,1)*S**-3.5);
  near(r.jointLowerTailGivenOne,1/Math.sqrt(3));
  const independent=evaluateMultivariateClayton({u,theta:0});near(independent.cdf,0.3*0.6*0.8);near(independent.density,1);
});
test('log-domain density remains finite for small probabilities and many dimensions',()=>{
  const r=evaluateMultivariateClayton({u:Array(32).fill(1e-100),theta:20});assert.ok(Number.isFinite(r.logDensity));assert.ok(r.cdf>0&&r.cdf<1e-100);
});
test('gamma-frailty sampling has uniform margins and correct joint event frequency',()=>{
  const r=sampleMultivariateClayton({theta:2,dimension:4,count:12000,seed:410});
  for(let j=0;j<4;j++)near(r.samples.reduce((n,row)=>n+row[j],0)/r.samples.length,0.5,0.02);
  const event=r.samples.filter(row=>row.every(v=>v<0.5)).length/r.samples.length;
  near(event,evaluateMultivariateClayton({u:[0.5,0.5,0.5,0.5],theta:2}).cdf,0.02);
  assert.deepEqual(sampleMultivariateClayton({theta:2,dimension:4,count:3,seed:410}).samples,r.samples.slice(0,3));
});
test('multivariate parameter fitting recovers generating theta with deterministic independent sample',()=>{
  const {samples}=sampleMultivariateClayton({theta:3,dimension:3,count:1600,seed:139});
  const fitted=fitMultivariateClayton({samples});assert.equal(fitted.status,'CONVERGED');near(fitted.theta,3,0.4);assert.ok(fitted.logLikelihood>0);
  const ll=t=>samples.reduce((s,u)=>s+evaluateMultivariateClayton({u,theta:t}).logDensity,0);
  assert.ok(fitted.logLikelihood>=ll(fitted.theta*0.99));assert.ok(fitted.logLikelihood>=ll(fitted.theta*1.01));
});
test('held-out tail calibration exposes binomial counts and pointwise intervals',()=>{
  const {samples}=sampleMultivariateClayton({theta:2,dimension:3,count:8000,seed:17});
  const r=calibrateClaytonLowerTail({samples,theta:2,thresholds:[0.1,0.3]});
  for(const x of r.results){near(x.empirical,x.count/samples.length);near(x.empirical,x.predicted,0.025);assert.ok(x.wilson95[0]<=x.empirical&&x.wilson95[1]>=x.empirical);}
});
test('Clayton rejects inconsistent dimensions, unknown fields and invalid parameters',()=>{
  assert.throws(()=>evaluateMultivariateClayton({u:[0,0.5],theta:2}),/inside/);
  assert.throws(()=>evaluateMultivariateClayton({u:[0.2,0.5],theta:-1}),/theta/);
  assert.throws(()=>fitMultivariateClayton({samples:Array.from({length:20},(_,i)=>i===0?[0.2,0.3,0.4]:[0.2,0.3])}),/dimension/);
  const payload={u:[0.2,0.4,0.6],theta:2};assert.deepEqual(runMotor('66',{action:'evaluate',payload}),evaluateMultivariateClayton(payload));
});
