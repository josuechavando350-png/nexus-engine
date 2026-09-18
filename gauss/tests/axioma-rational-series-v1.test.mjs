import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runRationalSeriesBank} from '../axioma/rational-series-v1.mjs';
import {getGaussLayer} from '../core/registry.mjs';
test('AXIOMA independently checks 25 rational polynomial and formal series operators',()=>{const r=runRationalSeriesBank();assert.equal(r.coveredOperators,25);assert.equal(r.validCases,2500);assert.equal(r.passedValidCases,2500,JSON.stringify(r.failures));assert.equal(r.invalidCases,75);assert.equal(r.passedInvalidRejections,75,JSON.stringify(r.failures));assert.deepStrictEqual(r,runRationalSeriesBank());});
test('AXIOMA detects false rational arithmetic and malformed rational acceptance',()=>{const r=runRationalSeriesBank({resolveLayer:id=>id==='GAUSS.MATH.RATIONAL_SERIES.DEGREE.802'?{execute:()=>({degree:-99})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
