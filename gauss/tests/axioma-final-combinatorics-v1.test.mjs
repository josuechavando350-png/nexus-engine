import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalCombinatoricsBank} from '../axioma/final-combinatorics-v1.mjs';
test('AXIOMA independently enumerates all 22 labeled combinatorics operators',()=>{
 const report=runFinalCombinatoricsBank();
 assert.equal(report.coveredOperators,22);
 assert.equal(report.validCases,2200);
 assert.equal(report.passedValidCases,2200,JSON.stringify(report.failures));
 assert.equal(report.invalidCases,66);
 assert.equal(report.passedInvalidRejections,66,JSON.stringify(report.failures));
 console.log('AXIOMA_FINAL_COMBINATORICS='+JSON.stringify({coveredOperators:report.coveredOperators,passedValidCases:report.passedValidCases,passedInvalidRejections:report.passedInvalidRejections,caseDigest:report.caseDigest}));
});
test('AXIOMA independent partitions reject fabricated cardinalities and invalid acceptance',()=>{
 const report=runFinalCombinatoricsBank({resolveLayer:id=>id==='GAUSS.MATH.STIRLING_SECOND.201'?{execute:()=>({value:'-1'})}:getGaussLayer(id)});
 assert.ok(report.failedValidCases>0);
 assert.ok(report.failedInvalidRejections>0);
});
