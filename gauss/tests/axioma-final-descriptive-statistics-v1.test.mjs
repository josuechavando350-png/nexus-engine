import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalDescriptiveStatisticsBank} from '../axioma/final-descriptive-statistics-v1.mjs';
test('AXIOMA checks 12 independent descriptive-statistics references',()=>{
 const r=runFinalDescriptiveStatisticsBank();assert.equal(r.coveredOperators,12);assert.equal(r.validCases,1200);assert.equal(r.passedValidCases,1200,JSON.stringify(r.failures));assert.equal(r.invalidCases,36);assert.equal(r.passedInvalidRejections,36,JSON.stringify(r.failures));
});
test('AXIOMA detects falsified descriptive moments and invalid acceptance',()=>{
 const r=runFinalDescriptiveStatisticsBank({resolveLayer:id=>id==='GAUSS.STATS.WEIGHTED_MOMENTS.014'?{execute:()=>({mean:0,variance:0,skewness:null,excessKurtosis:null})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);
});
