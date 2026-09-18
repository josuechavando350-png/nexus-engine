import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalRationalStatisticsBank} from '../axioma/final-rational-statistics-v1.mjs';
test('AXIOMA verifies continued fractions, Wilson and bootstrap using separate reference algorithms',()=>{const r=runFinalRationalStatisticsBank();assert.equal(r.coveredOperators,3);assert.equal(r.validCases,300);assert.equal(r.passedValidCases,300,JSON.stringify(r.failures));assert.equal(r.invalidCases,9);assert.equal(r.passedInvalidRejections,9,JSON.stringify(r.failures));});
test('AXIOMA rational reference rejects fabricated quotient and invalid acceptance',()=>{const r=runFinalRationalStatisticsBank({resolveLayer:id=>id==='GAUSS.MATH.RATIONAL_CONTINUED_FRACTION.056'?{execute:()=>({quotients:[123456789]})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
