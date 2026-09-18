import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalFiniteEventsBank} from '../axioma/final-finite-events-v1.mjs';
test('AXIOMA independently enumerates 23 exact coin, random walk and occupancy events',()=>{
 const report=runFinalFiniteEventsBank();
 assert.equal(report.coveredOperators,23);
 assert.equal(report.validCases,2300);
 assert.equal(report.passedValidCases,2300,JSON.stringify(report.failures));
 assert.equal(report.invalidCases,69);
 assert.equal(report.passedInvalidRejections,69,JSON.stringify(report.failures));
 console.log('AXIOMA_FINAL_EVENTS='+JSON.stringify({coveredOperators:report.coveredOperators,passedValidCases:report.passedValidCases,passedInvalidRejections:report.passedInvalidRejections,caseDigest:report.caseDigest}));
});
test('AXIOMA enumerated event references reject forged fractions and malformed acceptance',()=>{
 const report=runFinalFiniteEventsBank({resolveLayer:id=>id==='GAUSS.STATS.COIN_EXACT_HEADS.201'?{execute:()=>({numerator:'0',denominator:'1'})}:getGaussLayer(id)});
 assert.ok(report.failedValidCases>0);
 assert.ok(report.failedInvalidRejections>0);
});
