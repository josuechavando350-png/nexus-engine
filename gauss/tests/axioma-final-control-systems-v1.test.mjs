import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalControlSystemsBank} from '../axioma/final-control-systems-v1.mjs';
test('AXIOMA independently verifies twelve bounded control and dynamics operators',()=>{const r=runFinalControlSystemsBank();assert.equal(r.coveredOperators,12);assert.equal(r.validCases,1200);assert.equal(r.passedValidCases,1200,JSON.stringify(r.failures));assert.equal(r.invalidCases,36);assert.equal(r.passedInvalidRejections,36,JSON.stringify(r.failures));assert.equal(r.failedValidCases,0);assert.equal(r.failedInvalidRejections,0);});
test('AXIOMA catches forged state trajectories and malformed acceptance',()=>{const r=runFinalControlSystemsBank({resolveLayer:id=>id==='GAUSS.CONTROL.STATE_SPACE_TRAJECTORY.003'?{execute:()=>({states:[],steps:0})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
