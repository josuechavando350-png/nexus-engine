import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runSequence438Bank} from '../axioma/sequences-438-v1.mjs';
const banks=[runSequence438Bank];
for(const bank of banks){
 test(`AXIOMA ${bank.name}: 25 explicit independent operators`,()=>{
  const r=bank();assert.equal(r.coveredOperators,25);assert.equal(r.validCases,2500);assert.equal(r.passedValidCases,2500,JSON.stringify(r.failures));assert.equal(r.invalidCases,75);assert.equal(r.passedInvalidRejections,75,JSON.stringify(r.failures));assert.equal(r.failedValidCases+r.failedInvalidRejections,0);assert.deepStrictEqual(r,bank());
 });
}
test('AXIOMA new banks detect falsified output and permissive invalid-input handling',()=>{
 for(const [bank,id] of [[runSequence438Bank,'GAUSS.STATS.SEQ_SUBSET_SUM_COUNT.301']]){
  const r=bank({resolveLayer:key=>key===id?{execute:()=>({wrong:true})}:getGaussLayer(key)});
  assert.ok(r.failedValidCases>0,`missed mutation ${id}`);assert.ok(r.failedInvalidRejections>0,`missed malformed acceptance ${id}`);
 }
});
