import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runPrefixCodeBank} from '../axioma/prefix-codes-v1.mjs';
import {getGaussLayer} from '../core/registry.mjs';
test('AXIOMA independently checks 25 bounded binary coding operators',()=>{const r=runPrefixCodeBank();assert.equal(r.coveredOperators,25);assert.equal(r.validCases,2500);assert.equal(r.passedValidCases,2500,JSON.stringify(r.failures));assert.equal(r.invalidCases,75);assert.equal(r.passedInvalidRejections,75,JSON.stringify(r.failures));assert.deepStrictEqual(r,runPrefixCodeBank());});
test('AXIOMA catches false codeword lengths and invalid acceptance',()=>{const r=runPrefixCodeBank({resolveLayer:id=>id==='GAUSS.INFO.PREFIX_CODES.MAX_LENGTH.981'?{execute:()=>({length:-1})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
