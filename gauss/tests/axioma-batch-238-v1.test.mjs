import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runBitword238Bank} from '../axioma/bitwords-238-v1.mjs';
import {runFiniteSet238Bank} from '../axioma/finite-sets-238-v1.mjs';
import {runFiniteFunction238Bank} from '../axioma/finite-functions-238-v1.mjs';
import {runUrn238Bank} from '../axioma/urn-probability-238-v1.mjs';
import {runInterval238Bank} from '../axioma/intervals-238-v1.mjs';
import {runBinaryGrid238Bank} from '../axioma/binary-grids-238-v1.mjs';
import {runRootedTree238Bank} from '../axioma/rooted-trees-238-v1.mjs';
const banks=[runBitword238Bank,runFiniteSet238Bank,runFiniteFunction238Bank,runUrn238Bank,runInterval238Bank,runBinaryGrid238Bank,runRootedTree238Bank];
for(const bank of banks){
 test(`AXIOMA ${bank.name} independent 25 operators and 100 cases each`,()=>{
  const r=bank();assert.equal(r.coveredOperators,25);assert.equal(r.validCases,2500);assert.equal(r.passedValidCases,2500,JSON.stringify(r.failures));assert.equal(r.invalidCases,75);assert.equal(r.passedInvalidRejections,75,JSON.stringify(r.failures));assert.equal(r.failedValidCases+r.failedInvalidRejections,0);assert.deepStrictEqual(r,bank());
 });
}
test('AXIOMA 238 references detect a faulty subject and invalid-input acceptance',()=>{
 for(const [bank,id] of [[runBitword238Bank,'GAUSS.INFO.BIT_POPCOUNT.726'],[runFiniteSet238Bank,'GAUSS.MATH.SET_UNION.601'],[runFiniteFunction238Bank,'GAUSS.CS.FUNCTION_INDEGREES.751'],[runUrn238Bank,'GAUSS.STATS.URN_HYPERGEOMETRIC_DISTRIBUTION.776'],[runInterval238Bank,'GAUSS.CONTROL.INTERVAL_MERGE.651'],[runBinaryGrid238Bank,'GAUSS.CS.GRID_ONES.701'],[runRootedTree238Bank,'GAUSS.CS.TREE_PARENTS.626']]){
  const r=bank({resolveLayer:key=>key===id?{execute:()=>({wrong:true})}:getGaussLayer(key)});
  assert.ok(r.failedValidCases>0,`failed mutation detection ${id}`);assert.ok(r.failedInvalidRejections>0,`failed malformed acceptance detection ${id}`);
 }
});
