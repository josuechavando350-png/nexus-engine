import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalExactMarkovBank} from '../axioma/final-exact-markov-v1.mjs';
test('AXIOMA independently enumerates complete rational Markov paths for 23 missing operators',()=>{
 const report=runFinalExactMarkovBank();
 assert.equal(report.coveredOperators,23);
 assert.equal(report.validCases,2300);
 assert.equal(report.passedValidCases,2300,JSON.stringify(report.failures));
 assert.equal(report.invalidCases,69);
 assert.equal(report.passedInvalidRejections,69,JSON.stringify(report.failures));
 console.log('AXIOMA_FINAL_MARKOV='+JSON.stringify({coveredOperators:report.coveredOperators,passedValidCases:report.passedValidCases,passedInvalidRejections:report.passedInvalidRejections,caseDigest:report.caseDigest}));
});
test('AXIOMA exact Markov references reject deliberately altered probabilities and invalid acceptance',()=>{
 const report=runFinalExactMarkovBank({resolveLayer:id=>id==='GAUSS.STATS.EXACT_MARKOV.STEP_DISTRIBUTION.952'?{execute:()=>({distribution:['0/1']})}:getGaussLayer(id)});
 assert.ok(report.failedValidCases>0);
 assert.ok(report.failedInvalidRejections>0);
});
