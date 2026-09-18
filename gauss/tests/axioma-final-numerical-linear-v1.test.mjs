import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalNumericalLinearBank} from '../axioma/final-numerical-linear-v1.mjs';
test('AXIOMA independently checks seven numerical operators with analytical Cramer and DFT references',()=>{const r=runFinalNumericalLinearBank();assert.equal(r.coveredOperators,7);assert.equal(r.validCases,700);assert.equal(r.passedValidCases,700,JSON.stringify(r.failures));assert.equal(r.invalidCases,21);assert.equal(r.passedInvalidRejections,21,JSON.stringify(r.failures));});
test('AXIOMA catches forged numerical solution and malformed acceptance',()=>{const r=runFinalNumericalLinearBank({resolveLayer:id=>id==='GAUSS.MATH.GAUSSIAN_SOLVE.005'?{execute:()=>({solution:[-999]})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
