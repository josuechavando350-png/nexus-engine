import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalComputationalGeometryBank} from '../axioma/final-computational-geometry-v1.mjs';
test('AXIOMA checks thirteen bounded integer geometry operators against independent rectangle and determinant oracles',()=>{const r=runFinalComputationalGeometryBank();assert.equal(r.coveredOperators,13);assert.equal(r.validCases,1300);assert.equal(r.passedValidCases,1300,JSON.stringify(r.failures));assert.equal(r.invalidCases,39);assert.equal(r.passedInvalidRejections,39,JSON.stringify(r.failures));assert.equal(r.failedValidCases,0);assert.equal(r.failedInvalidRejections,0);});
test('AXIOMA rejects a fabricated geometric orientation and malformed acceptance',()=>{const r=runFinalComputationalGeometryBank({resolveLayer:id=>id==='GAUSS.MATH.ORIENTATION_2D.022'?{execute:()=>({twiceSignedArea:999,orientation:1})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
