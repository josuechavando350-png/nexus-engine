import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalInformationControlBank} from '../axioma/final-information-control-v1.mjs';
test('AXIOMA independently checks 3 information measures and 2 scalar controls',()=>{
 const r=runFinalInformationControlBank();assert.equal(r.coveredOperators,5);assert.equal(r.validCases,500);assert.equal(r.passedValidCases,500,JSON.stringify(r.failures));assert.equal(r.invalidCases,15);assert.equal(r.passedInvalidRejections,15,JSON.stringify(r.failures));assert.equal(r.failedValidCases,0);assert.equal(r.failedInvalidRejections,0);
});
test('AXIOMA detects forged mutual information and invalid acceptance',()=>{
 const r=runFinalInformationControlBank({resolveLayer:id=>id==='GAUSS.INFO.MUTUAL_INFORMATION.002'?{execute:()=>({mutualInformation:999,base:2})}:getGaussLayer(id)});
 assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);
});
