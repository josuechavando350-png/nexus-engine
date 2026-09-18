import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runWeightedTreeBank} from '../axioma/weighted-trees-v1.mjs';
import {getGaussLayer} from '../core/registry.mjs';
test('AXIOMA checks 25 weighted tree operators against independent simple-path enumeration',()=>{const r=runWeightedTreeBank();assert.equal(r.coveredOperators,25);assert.equal(r.validCases,2500);assert.equal(r.passedValidCases,2500,JSON.stringify(r.failures));assert.equal(r.invalidCases,75);assert.equal(r.passedInvalidRejections,75,JSON.stringify(r.failures));assert.deepStrictEqual(r,runWeightedTreeBank());});
test('AXIOMA rejects fabricated tree distances and malformed tree acceptance',()=>{const r=runWeightedTreeBank({resolveLayer:id=>id==='GAUSS.CS.WEIGHTED_TREES.PAIR_DISTANCE.906'?{execute:()=>({distance:'-1'})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
