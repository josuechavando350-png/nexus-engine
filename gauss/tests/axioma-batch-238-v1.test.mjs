import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runBitword238Bank} from '../axioma/bitwords-238-v1.mjs';
import {runFiniteSet238Bank} from '../axioma/finite-sets-238-v1.mjs';
const banks=[runBitword238Bank,runFiniteSet238Bank];
for(const bank of banks){
 test(`AXIOMA ${bank.name} independent 25 operators and 100 cases each`,()=>{
  const r=bank();assert.equal(r.coveredOperators,25);assert.equal(r.validCases,2500);assert.equal(r.passedValidCases,2500,JSON.stringify(r.failures));assert.equal(r.invalidCases,75);assert.equal(r.passedInvalidRejections,75,JSON.stringify(r.failures));assert.equal(r.failedValidCases+r.failedInvalidRejections,0);assert.deepStrictEqual(r,bank());
 });
}
test('AXIOMA 238 references detect a faulty subject and invalid-input acceptance',()=>{
 for(const [bank,id] of [[runBitword238Bank,'GAUSS.INFO.BIT_POPCOUNT.726'],[runFiniteSet238Bank,'GAUSS.MATH.SET_UNION.601']]){
  const r=bank({resolveLayer:key=>key===id?{execute:()=>({wrong:true})}:getGaussLayer(key)});
  assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);
 }
});
