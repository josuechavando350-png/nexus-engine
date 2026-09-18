import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalDiscreteInformationBank} from '../axioma/final-discrete-information-v1.mjs';
test('AXIOMA independently checks twelve finite-alphabet information operators',()=>{
 const r=runFinalDiscreteInformationBank();assert.equal(r.coveredOperators,12);assert.equal(r.validCases,1200);assert.equal(r.passedValidCases,1200,JSON.stringify(r.failures));assert.equal(r.invalidCases,36);assert.equal(r.passedInvalidRejections,36,JSON.stringify(r.failures));assert.equal(r.failedValidCases,0);assert.equal(r.failedInvalidRejections,0);
});
test('AXIOMA detects forged KL divergences and invalid acceptance',()=>{
 const r=runFinalDiscreteInformationBank({resolveLayer:id=>id==='GAUSS.INFO.KL_DIVERGENCE.018'?{execute:()=>({kind:'FINITE',divergence:999})}:getGaussLayer(id)});
 assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);
});
