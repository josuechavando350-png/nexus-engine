import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalBasicNumberTheoryBank} from '../axioma/final-basic-number-theory-v1.mjs';
test('AXIOMA independently checks 12 bounded exact number-theory operators',()=>{
 const r=runFinalBasicNumberTheoryBank();assert.equal(r.coveredOperators,12);assert.equal(r.validCases,1200);assert.equal(r.passedValidCases,1200,JSON.stringify(r.failures));assert.equal(r.invalidCases,36);assert.equal(r.passedInvalidRejections,36,JSON.stringify(r.failures));
});
test('AXIOMA independently checks Bezout witness and detects wrong subject and invalid acceptance',()=>{
 const r=runFinalBasicNumberTheoryBank({resolveLayer:id=>id==='GAUSS.MATH.EXTENDED_EUCLID.010'?{execute:()=>({gcd:0,bezoutX:0,bezoutY:0})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);
});
