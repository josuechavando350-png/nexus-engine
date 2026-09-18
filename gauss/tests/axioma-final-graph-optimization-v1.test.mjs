import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalGraphOptimizationBank} from '../axioma/final-graph-optimization-v1.mjs';
test('AXIOMA enumerates seven graph optimization problems independently',()=>{const r=runFinalGraphOptimizationBank();assert.equal(r.coveredOperators,7);assert.equal(r.validCases,700);assert.equal(r.passedValidCases,700,JSON.stringify(r.failures));assert.equal(r.invalidCases,21);assert.equal(r.passedInvalidRejections,21,JSON.stringify(r.failures));});
test('AXIOMA rejects a forged shortest path and permissive malformed input',()=>{const r=runFinalGraphOptimizationBank({resolveLayer:id=>id==='GAUSS.CS.DIJKSTRA_SHORTEST_PATH.003'?{execute:()=>({reachable:true,distance:-1,path:[0,1],examinedVertices:2})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
