import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalPolynomialAlgebraBank} from '../axioma/final-polynomial-algebra-v1.mjs';
test('AXIOMA independently checks twelve real polynomial operators',()=>{const r=runFinalPolynomialAlgebraBank();assert.equal(r.coveredOperators,12);assert.equal(r.validCases,1200);assert.equal(r.passedValidCases,1200,JSON.stringify(r.failures));assert.equal(r.invalidCases,36);assert.equal(r.passedInvalidRejections,36,JSON.stringify(r.failures));assert.equal(r.failedValidCases,0);assert.equal(r.failedInvalidRejections,0);});
test('AXIOMA rejects a fabricated polynomial evaluation and malformed acceptance',()=>{const r=runFinalPolynomialAlgebraBank({resolveLayer:id=>id==='GAUSS.MATH.HORNER_EVALUATION.035'?{execute:()=>({value:999})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
