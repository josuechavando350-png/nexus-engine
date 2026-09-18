import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalAdvancedGraphsBank} from '../axioma/final-advanced-graphs-v1.mjs';
test('AXIOMA checks nine advanced graph algorithms against independent exhaustive references',()=>{const r=runFinalAdvancedGraphsBank();assert.equal(r.coveredOperators,9);assert.equal(r.validCases,900);assert.equal(r.passedValidCases,900,JSON.stringify(r.failures));assert.equal(r.invalidCases,27);assert.equal(r.passedInvalidRejections,27,JSON.stringify(r.failures));});
test('AXIOMA detects fabricated signed shortest path and malformed acceptance',()=>{const r=runFinalAdvancedGraphsBank({resolveLayer:id=>id==='GAUSS.CS.BELLMAN_FORD_SIGNED.010'?{execute:()=>({reachable:true,distance:-999,path:[0,1]})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
