import test from 'node:test';
import assert from 'node:assert/strict';
import {gaussianDivergence,piecewiseContinuousDivergence,runMotor} from '../src/index.mjs';
const near=(a,b,tol=1e-10)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);
test('Gaussian univariate KL agrees with scalar analytic formula',()=>{
  const r=gaussianDivergence({p:{mean:[2],covariance:[[4]]},q:{mean:[-1],covariance:[[9]]}});
  near(r.kl,Math.log(3/2)+(4+9)/(2*9)-0.5);near(r.crossEntropy-r.entropy,r.kl);
});
test('correlated Gaussian KL is zero at identity and invariant under shared invertible transform',()=>{
  const p={mean:[0,0],covariance:[[1,0],[0,4]]},q={mean:[1,2],covariance:[[4,0],[0,1]]};
  near(gaussianDivergence({p,q:p}).kl,0);
  // A=[[1,1],[0,2]], with covariance A Sigma A^T.
  const pp={mean:[0,0],covariance:[[5,8],[8,16]]},qq={mean:[3,4],covariance:[[5,2],[2,4]]};
  near(gaussianDivergence({p,q}).kl,gaussianDivergence({p:pp,q:qq}).kl);
});
test('Gaussian dimensions, singular covariance and asymmetry fail explicitly',()=>{
  const g={mean:[0],covariance:[[1]]};
  assert.throws(()=>gaussianDivergence({p:g,q:{mean:[0],covariance:[[0]]}}),/positive definite/);
  assert.throws(()=>gaussianDivergence({p:g,q:{mean:[0,0],covariance:[[1,0.3],[0.2,1]]}}),/symmetric/);
  assert.throws(()=>gaussianDivergence({p:g,q:{mean:[0,0],covariance:[[1,0],[0,1]]}}),/dimensions/);
});
test('piecewise densities use interval width and differential entropy rather than discrete masses',()=>{
  const p={edges:[0,2],density:[0.5]},q={edges:[0,1,2],density:[0.25,0.75]};
  const r=piecewiseContinuousDivergence({p,q});near(r.entropy,Math.log(2));near(r.kl,0.5*Math.log(4/3));near(r.crossEntropy-r.entropy,r.kl);
});
test('continuous support mismatch gives infinite KL and finite Jensen-Shannon',()=>{
  const p={edges:[0,1],density:[1]},q={edges:[2,3],density:[1]};
  const r=piecewiseContinuousDivergence({p,q,base:2});assert.equal(r.kl,'Infinity');near(r.jensenShannon,1);near(r.entropy,0);
});
test('partition refinement leaves density divergence unchanged and invalid normalization fails',()=>{
  const p={edges:[0,1],density:[1]},q={edges:[0,0.2,0.4,1],density:[1,1,1]};near(piecewiseContinuousDivergence({p,q}).kl,0);
  assert.throws(()=>piecewiseContinuousDivergence({p,q:{edges:[0,1],density:[2]}}),/integral/);
  assert.throws(()=>piecewiseContinuousDivergence({p,q:{edges:[1,0],density:[1]}}),/increase/);
  const payload={p,q};assert.deepEqual(runMotor('71',{action:'piecewise',payload}),piecewiseContinuousDivergence(payload));
});
