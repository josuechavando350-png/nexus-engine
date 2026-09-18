import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runBooleanBank} from '../axioma/boolean-functions-v1.mjs';
import {getGaussLayer} from '../core/registry.mjs';
test('AXIOMA: 25 independently enumerated Boolean operators',()=>{const r=runBooleanBank();assert.equal(r.coveredOperators,25);assert.equal(r.validCases,2500);assert.equal(r.passedValidCases,2500,JSON.stringify(r.failures));assert.equal(r.invalidCases,75);assert.equal(r.passedInvalidRejections,75,JSON.stringify(r.failures));assert.deepStrictEqual(r,runBooleanBank());});
test('AXIOMA detects false Boolean arithmetic and acceptance of malformed inputs',()=>{const r=runBooleanBank({resolveLayer:id=>id==='GAUSS.CS.BOOLEAN_FUNCTIONS.WEIGHT.852'?{execute:()=>({ones:-1})}:id==='GAUSS.CS.BOOLEAN_FUNCTIONS.BALANCED.854'?{execute:()=>({balanced:true})}:id==='GAUSS.CS.BOOLEAN_FUNCTIONS.EVALUATE.851'?{execute:()=>({value:0})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
