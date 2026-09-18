import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runNumberTheoryBank} from '../axioma/number-theory-v1.mjs';
import {getGaussLayer} from '../core/registry.mjs';

test('AXIOMA independently checks 11 unique exact number-theory operators',()=>{
  const report=runNumberTheoryBank();
  assert.equal(report.coveredOperators,11);
  assert.equal(new Set(report.operatorResults.map(item=>item.id)).size,11);
  assert.equal(report.validCases,1100);
  assert.equal(report.passedValidCases,1100,JSON.stringify(report.failures));
  assert.equal(report.failedValidCases,0);
  assert.equal(report.invalidCases,33);
  assert.equal(report.passedInvalidRejections,33,JSON.stringify(report.failures));
  assert.equal(report.failedInvalidRejections,0);
  assert.match(report.caseDigest,/^sha256:[a-f0-9]{64}$/);
  assert.deepStrictEqual(report,runNumberTheoryBank(),'same seed and SHA must reproduce byte-for-byte');
  console.log(`AXIOMA_NUMBER_THEORY_V1=${JSON.stringify({coveredOperators:report.coveredOperators,validCases:report.validCases,passedValidCases:report.passedValidCases,invalidCases:report.invalidCases,passedInvalidRejections:report.passedInvalidRejections,caseDigest:report.caseDigest})}`);
});

test('AXIOMA detects a deliberately broken divisor-count implementation and invalid acceptance',()=>{
  const broken=runNumberTheoryBank({resolveLayer:id=>id==='GAUSS.MATH.DIVISOR_COUNT.049'?{execute:()=>({count:0})}:getGaussLayer(id)});
  assert.ok(broken.failedValidCases>0);
  assert.ok(broken.failedInvalidRejections>0);
});
