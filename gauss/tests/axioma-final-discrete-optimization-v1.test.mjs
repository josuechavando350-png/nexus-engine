import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalDiscreteOptimizationBank} from '../axioma/final-discrete-optimization-v1.mjs';
test('AXIOMA checks eleven bounded combinatorial operators against independent exhaustive references',()=>{const r=runFinalDiscreteOptimizationBank();assert.equal(r.coveredOperators,11);assert.equal(r.validCases,1100);assert.equal(r.passedValidCases,1100,JSON.stringify(r.failures));assert.equal(r.invalidCases,33);assert.equal(r.passedInvalidRejections,33,JSON.stringify(r.failures));});
test('AXIOMA catches a fabricated optimization value and malformed acceptance',()=>{const r=runFinalDiscreteOptimizationBank({resolveLayer:id=>id==='GAUSS.CS.MATRIX_CHAIN.019'?{execute:()=>({scalarMultiplications:-1,parenthesization:''})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
