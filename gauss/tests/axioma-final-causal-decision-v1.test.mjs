import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalCausalDecisionBank} from '../axioma/final-causal-decision-v1.mjs';
test('AXIOMA checks four causal and decision operators against independent sums and payoff enumeration',()=>{
 const report=runFinalCausalDecisionBank();
 assert.equal(report.coveredOperators,4);assert.equal(report.validCases,400);assert.equal(report.passedValidCases,400,JSON.stringify(report.failures));
 assert.equal(report.invalidCases,12);assert.equal(report.passedInvalidRejections,12,JSON.stringify(report.failures));
 assert.equal(report.failedValidCases,0);assert.equal(report.failedInvalidRejections,0);
});
test('AXIOMA detects fabricated causal estimates and acceptance of malformed decisions',()=>{
 const report=runFinalCausalDecisionBank({resolveLayer:id=>id==='GAUSS.CAUSAL.DID.001'?{execute:()=>({treatedChange:0,controlChange:0,estimate:999})}:getGaussLayer(id)});
 assert.ok(report.failedValidCases>0);assert.ok(report.failedInvalidRejections>0);
});
