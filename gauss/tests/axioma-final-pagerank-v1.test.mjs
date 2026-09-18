import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalPageRankBank} from '../axioma/final-pagerank-v1.mjs';
test('AXIOMA checks PageRank against independently solved two-vertex stationary equation',()=>{const r=runFinalPageRankBank();assert.equal(r.coveredOperators,1);assert.equal(r.validCases,100);assert.equal(r.passedValidCases,100,JSON.stringify(r.failures));assert.equal(r.invalidCases,3);assert.equal(r.passedInvalidRejections,3,JSON.stringify(r.failures));});
test('AXIOMA catches false PageRank and malformed acceptance',()=>{const r=runFinalPageRankBank({resolveLayer:id=>id==='GAUSS.INFO.PAGERANK.004'?{execute:()=>({scores:[0,0]})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
