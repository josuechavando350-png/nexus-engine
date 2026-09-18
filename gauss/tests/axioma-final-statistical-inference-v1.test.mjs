import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalStatisticalInferenceBank} from '../axioma/final-statistical-inference-v1.mjs';
test('AXIOMA checks nine finite-sample statistical inference references',()=>{const r=runFinalStatisticalInferenceBank();assert.equal(r.coveredOperators,9);assert.equal(r.validCases,900);assert.equal(r.passedValidCases,900,JSON.stringify(r.failures));assert.equal(r.invalidCases,27);assert.equal(r.passedInvalidRejections,27,JSON.stringify(r.failures));assert.equal(r.failedValidCases,0);assert.equal(r.failedInvalidRejections,0);});
test('AXIOMA detects fabricated weighted regression and malformed input acceptance',()=>{const r=runFinalStatisticalInferenceBank({resolveLayer:id=>id==='GAUSS.STATS.WLS_LINE.004'?{execute:()=>({slope:999})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
