import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalRiskPersistenceBank} from '../axioma/final-risk-persistence-v1.mjs';
test('AXIOMA verifies two discrete risk operators and H0 persistence against independent references',()=>{const r=runFinalRiskPersistenceBank();assert.equal(r.coveredOperators,3);assert.equal(r.validCases,300);assert.equal(r.passedValidCases,300,JSON.stringify(r.failures));assert.equal(r.invalidCases,9);assert.equal(r.passedInvalidRejections,9,JSON.stringify(r.failures));});
test('AXIOMA catches fraudulent risk results and invalid acceptance',()=>{const r=runFinalRiskPersistenceBank({resolveLayer:id=>id==='GAUSS.DECISION.CVAR_DISCRETE.003'?{execute:()=>({valueAtRisk:-999})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
