import test from 'node:test';
import assert from 'node:assert/strict';
import {runMotor,runMotorPipeline} from '../src/index.mjs';
test('84 returned policy is greedy for returned values even at iteration limit',()=>{
 const r=runMotor('84',{transitions:[[[1,0],[0,1]],[[0,1],[0,1]]],rewards:[[1,0],[10,10]],discount:.5,maxIterations:1});
 assert.deepEqual(r.values,[1,10]);assert.equal(r.policy[0],1);assert.equal(r.converged,false);
});
test('85 reports real primal-dual gap instead of multiplying unused barrier parameter',()=>{
 const input={H:[[1]],c:[-2],A:[[1],[-1]],b:[3,3],initial:[0],outerIterations:1,newtonIterations:1};
 const r=runMotor('85',input),error=r.objective-(-2);
 assert.ok(r.primalDualGap+1e-12>=error);assert.equal(r.centralPathComplementarity,2);assert.ok(r.primalDualGap>=2);assert.equal(r.status,'ITERATION_LIMIT');
 const converged=runMotor('85',{...input,outerIterations:12,newtonIterations:80,tolerance:1e-7});assert.equal(converged.status,'CONVERGED');assert.ok(Math.abs(converged.solution[0]-2)<1e-6);assert.ok(converged.primalDualGap<=1e-7);
});
test('pipeline blocks downstream work after optimizer iteration limit',async()=>{
 const r=await runMotorPipeline({tasks:[{id:'incomplete',motor:'85',input:{H:[[1]],c:[-2],A:[[1],[-1]],b:[3,3],initial:[0],outerIterations:1,newtonIterations:1}},{id:'mustNotRun',motor:'71',input:{p:[.5,.5],q:[.5,.5]}}]});
 assert.equal(r.status,'BLOCKED');assert.equal(r.failedTaskId,'incomplete');assert.equal(r.tasks.length,0);
});
