import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runSequence438Bank} from '../axioma/sequences-438-v1.mjs';
import {runIntegerPolynomial438Bank} from '../axioma/integer-polynomials-438-v1.mjs';
import {runIntegerMatrix438Bank} from '../axioma/integer-matrices-438-v1.mjs';
import {runGraphInvariant438Bank} from '../axioma/graph-invariants-438-v1.mjs';
import {runUnicode438Bank} from '../axioma/unicode-strings-438-v1.mjs';
import {runFiniteNumber438Bank} from '../axioma/finite-number-theory-438-v1.mjs';
import {runHypergraph438Bank} from '../axioma/hypergraphs-438-v1.mjs';
import {runPoset438Bank} from '../axioma/posets-438-v1.mjs';
import {runGeometry438Bank} from '../axioma/lattice-geometry-438-v1.mjs';
import {runGf2Coding438Bank} from '../axioma/gf2-codes-438-v1.mjs';
const banks=[runSequence438Bank,runIntegerPolynomial438Bank,runIntegerMatrix438Bank,runGraphInvariant438Bank,runUnicode438Bank,runFiniteNumber438Bank,runHypergraph438Bank,runPoset438Bank,runGeometry438Bank,runGf2Coding438Bank];
for(const bank of banks){
 test(`AXIOMA ${bank.name}: 25 explicit independent operators`,()=>{
  const r=bank();assert.equal(r.coveredOperators,25);assert.equal(r.validCases,2500);assert.equal(r.passedValidCases,2500,JSON.stringify(r.failures));assert.equal(r.invalidCases,75);assert.equal(r.passedInvalidRejections,75,JSON.stringify(r.failures));assert.equal(r.failedValidCases+r.failedInvalidRejections,0);assert.deepStrictEqual(r,bank());
 });
}
test('AXIOMA new banks detect falsified output and permissive invalid-input handling',()=>{
 for(const [bank,id] of [[runSequence438Bank,'GAUSS.STATS.SEQ_SUBSET_SUM_COUNT.301'],[runIntegerPolynomial438Bank,'GAUSS.MATH.EXACT_POLY_ADD.301'],[runIntegerMatrix438Bank,'GAUSS.MATH.EXACT_MATRIX_ADD.326'],[runGraphInvariant438Bank,'GAUSS.CS.GRAPH_DEGREE_SEQUENCE.301'],[runUnicode438Bank,'GAUSS.CS.PREFIX_FUNCTION.201'],[runFiniteNumber438Bank,'GAUSS.MATH.MERTENS.223'],[runHypergraph438Bank,'GAUSS.CS.HYPER_VERTEX_DEGREES.551'],[runPoset438Bank,'GAUSS.MATH.POSET_TRANSITIVE_CLOSURE.501'],[runGeometry438Bank,'GAUSS.MATH.DOT3.401'],[runGf2Coding438Bank,'GAUSS.INFO.GF2_RANK.401']]){
  const r=bank({resolveLayer:key=>key===id?{execute:()=>({wrong:true})}:getGaussLayer(key)});
  assert.ok(r.failedValidCases>0,`missed mutation ${id}`);assert.ok(r.failedInvalidRejections>0,`missed malformed acceptance ${id}`);
 }
});
