import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {runMotor,runMotorPipeline} from '../src/index.mjs';
const input={field:[0.2,0.3],couplings:[[0,1],[1,0]],iterations:1,tolerance:1e-12};
test('pipeline rejects unconverged mean-field inference and blocks dependent tasks',async()=>{
  assert.equal(runMotor('51',input).converged,false);
  const r=await runMotorPipeline({tasks:[{id:'infer',motor:'51',input},{id:'downstream',motor:'71',input:{p:{$ref:{taskId:'infer',path:['probabilityPlus']}},q:[0.5,0.5]}}]});
  assert.equal(r.status,'BLOCKED');assert.equal(r.failedTaskId,'infer');assert.equal(r.tasks.length,0);
});
test('CLI returns unsuccessful exit status for unconverged mean-field inference',()=>{
  const r=spawnSync(process.execPath,['cli.mjs','motor','examples/v13/motor-51-nonconverged.json','51'],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
  assert.equal(r.status,1,r.stderr);assert.equal(JSON.parse(r.stdout).converged,false);
});
test('mean-field contraction error bound covers independent scalar fixed-point solution',()=>{
  const r=runMotor('51',{field:[0.3,0.3],couplings:[[0,0.4],[0.4,0]],iterations:1,tolerance:1e-15});
  // Symmetric unique solution solves m=tanh(0.3+0.4*m), found independently by bisection.
  let lo=-1,hi=1;for(let i=0;i<100;i++){const mid=(lo+hi)/2;if(mid-Math.tanh(0.3+0.4*mid)>0)hi=mid;else lo=mid;}
  const truth=(lo+hi)/2,c=r.contractionCertificate;assert.equal(c.applicable,true);
  assert.ok(Math.max(...r.means.map(m=>Math.abs(m-truth)))<=c.infinityNormErrorBound+1e-14);
  assert.equal(c.contractionFactor,0.4);
});
test('mean-field convergence is checked at returned values and no contraction bound is invented',()=>{
  const r=runMotor('51',{field:[0.3,0.3],couplings:[[0,0.4],[0.4,0]],tolerance:1e-12});
  assert.equal(r.converged,true);assert.ok(r.fixedPointResidual<1e-12);assert.ok(r.contractionCertificate.infinityNormErrorBound<1e-11);
  const unproved=runMotor('51',input);assert.equal(unproved.contractionCertificate.applicable,false);assert.equal(unproved.contractionCertificate.infinityNormErrorBound,null);
});
