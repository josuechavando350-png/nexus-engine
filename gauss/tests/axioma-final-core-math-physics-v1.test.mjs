import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalCoreMathPhysicsBank} from '../axioma/final-core-math-physics-v1.mjs';
test('AXIOMA checks 7 independent finite transport, Pareto, physics and calibration references',()=>{
 const r=runFinalCoreMathPhysicsBank();
 assert.equal(r.coveredOperators,7);assert.equal(r.validCases,700);assert.equal(r.passedValidCases,700,JSON.stringify(r.failures));
 assert.equal(r.invalidCases,21);assert.equal(r.passedInvalidRejections,21,JSON.stringify(r.failures));
 assert.equal(r.failedValidCases,0);assert.equal(r.failedInvalidRejections,0);
});
test('AXIOMA detects forged Ising energy and accepts no invalid spins',()=>{
 const r=runFinalCoreMathPhysicsBank({resolveLayer:id=>id==='GAUSS.PHYSICS.ISING_ENERGY.002'?{execute:()=>({energy:999})}:getGaussLayer(id)});
 assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);
});
