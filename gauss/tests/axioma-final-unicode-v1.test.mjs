import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalUnicodeIndexBank} from '../axioma/final-unicode-index-v1.mjs';
test('AXIOMA checks all three remaining Unicode suffix, LCP and KMP operators',()=>{
 const report=runFinalUnicodeIndexBank();
 assert.equal(report.coveredOperators,3);
 assert.equal(report.validCases,300);
 assert.equal(report.passedValidCases,300,JSON.stringify(report.failures));
 assert.equal(report.invalidCases,9);
 assert.equal(report.passedInvalidRejections,9,JSON.stringify(report.failures));
});
test('AXIOMA Unicode index references reject false results and malformed inputs',()=>{
 const report=runFinalUnicodeIndexBank({resolveLayer:id=>id==='GAUSS.CS.UNICODE_SUFFIX_ARRAY.226'?{execute:()=>({indices:[],unit:'UNICODE_CODE_POINT'})}:getGaussLayer(id)});
 assert.ok(report.failedValidCases>0);
 assert.ok(report.failedInvalidRejections>0);
});
