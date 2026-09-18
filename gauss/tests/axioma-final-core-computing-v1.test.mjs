import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalCoreComputingBank} from '../axioma/final-core-computing-v1.mjs';
test('AXIOMA checks exact knapsack and finite trace LTL against independent exhaustive reference',()=>{const r=runFinalCoreComputingBank();assert.equal(r.coveredOperators,2);assert.equal(r.validCases,200);assert.equal(r.passedValidCases,200,JSON.stringify(r.failures));assert.equal(r.passedInvalidRejections,6,JSON.stringify(r.failures));});
test('AXIOMA independently rejects fabricated subset optimum and invalid acceptance',()=>{const r=runFinalCoreComputingBank({resolveLayer:id=>id==='GAUSS.CS.KNAPSACK_EXACT.001'?{execute:()=>({selectedIds:[],totalValue:0})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
