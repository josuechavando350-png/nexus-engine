import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runModularMatrixBank} from '../axioma/modular-matrices-v1.mjs';
import {getGaussLayer} from '../core/registry.mjs';
test('AXIOMA verifies 25 exact prime-field matrix operators by independent determinants and row spaces',()=>{const r=runModularMatrixBank();assert.equal(r.coveredOperators,25);assert.equal(r.validCases,2500);assert.equal(r.passedValidCases,2500,JSON.stringify(r.failures));assert.equal(r.invalidCases,75);assert.equal(r.passedInvalidRejections,75,JSON.stringify(r.failures));assert.deepStrictEqual(r,runModularMatrixBank());});
test('AXIOMA catches fabricated modular determinant and acceptance of invalid fields',()=>{const r=runModularMatrixBank({resolveLayer:id=>id==='GAUSS.MATH.MODULAR_MATRICES.DETERMINANT.934'?{execute:()=>({determinant:-1})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
