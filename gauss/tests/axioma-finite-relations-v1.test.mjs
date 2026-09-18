import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runFiniteRelationBank} from '../axioma/finite-relations-v1.mjs';
import {getGaussLayer} from '../core/registry.mjs';
test('AXIOMA independently enumerates 25 finite relation operators',()=>{const r=runFiniteRelationBank();assert.equal(r.coveredOperators,25);assert.equal(r.validCases,2500);assert.equal(r.passedValidCases,2500,JSON.stringify(r.failures));assert.equal(r.invalidCases,75);assert.equal(r.passedInvalidRejections,75,JSON.stringify(r.failures));assert.deepStrictEqual(r,runFiniteRelationBank());});
test('AXIOMA detects wrong relation set and improperly accepted malformed relations',()=>{const r=runFiniteRelationBank({resolveLayer:id=>id==='GAUSS.CS.FINITE_RELATIONS.DOMAIN.876'?{execute:()=>({elements:[]})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
