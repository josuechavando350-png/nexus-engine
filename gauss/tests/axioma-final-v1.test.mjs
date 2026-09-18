import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalPrimePolynomialBank} from '../axioma/final-prime-polynomials-v1.mjs';

test('AXIOMA verifies the remaining 13 prime-field polynomial operators independently',()=>{
 const report=runFinalPrimePolynomialBank();
 assert.equal(report.coveredOperators,13);
 assert.equal(report.validCases,1300);
 assert.equal(report.passedValidCases,1300,JSON.stringify(report.failures));
 assert.equal(report.invalidCases,39);
 assert.equal(report.passedInvalidRejections,39,JSON.stringify(report.failures));
 console.log('AXIOMA_FINAL_PRIME='+JSON.stringify({coveredOperators:report.coveredOperators,validCases:report.validCases,passed:report.passedValidCases,invalid:report.invalidCases,rejected:report.passedInvalidRejections,caseDigest:report.caseDigest}));
});
test('AXIOMA final references reject deliberately falsified polynomial outputs and invalid acceptance',()=>{
 const report=runFinalPrimePolynomialBank({resolveLayer:id=>id==='GAUSS.MATH.FP_DIVMOD.683'?{execute:x=>'AXIOMA_UNDECLARED' in (x??{})?{quotient:[0],remainder:[0]}:{quotient:[0],remainder:[0]}}:getGaussLayer(id)});
 assert.ok(report.failedValidCases>0);
 assert.ok(report.failedInvalidRejections>0);
});
