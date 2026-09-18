import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalNumberTheoryTailBank} from '../axioma/final-number-theory-tail-v1.mjs';
test('AXIOMA checks finite quadratic residues and primitive roots by separate residue enumeration',()=>{
 const r=runFinalNumberTheoryTailBank();assert.equal(r.coveredOperators,2);assert.equal(r.validCases,200);assert.equal(r.passedValidCases,200,JSON.stringify(r.failures));assert.equal(r.invalidCases,6);assert.equal(r.passedInvalidRejections,6,JSON.stringify(r.failures));
});
test('AXIOMA residue counting catches altered subjects and permissive invalid handling',()=>{
 const r=runFinalNumberTheoryTailBank({resolveLayer:id=>id==='GAUSS.MATH.QUADRATIC_RESIDUE_COUNT.248'?{execute:()=>({value:'-1'})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);
});
