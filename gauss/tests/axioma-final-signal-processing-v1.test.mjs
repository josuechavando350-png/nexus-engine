import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalSignalProcessingBank} from '../axioma/final-signal-processing-v1.mjs';
test('AXIOMA checks twelve signal algorithms against analytic impulse responses',()=>{const r=runFinalSignalProcessingBank();assert.equal(r.coveredOperators,12);assert.equal(r.validCases,1200);assert.equal(r.passedValidCases,1200,JSON.stringify(r.failures));assert.equal(r.invalidCases,36);assert.equal(r.passedInvalidRejections,36,JSON.stringify(r.failures));assert.equal(r.failedValidCases,0);assert.equal(r.failedInvalidRejections,0);});
test('AXIOMA rejects a forged Fourier impulse and invalid acceptance',()=>{const r=runFinalSignalProcessingBank({resolveLayer:id=>id==='GAUSS.INFO.DIRECT_DFT.006'?{execute:()=>({real:[],imaginary:[]})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
