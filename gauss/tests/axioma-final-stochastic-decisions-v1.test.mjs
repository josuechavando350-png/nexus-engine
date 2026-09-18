import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalStochasticDecisionsBank} from '../axioma/final-stochastic-decisions-v1.mjs';
test('AXIOMA independently verifies twelve bounded stochastic and sequential decision operators',()=>{const r=runFinalStochasticDecisionsBank();assert.equal(r.coveredOperators,12);assert.equal(r.validCases,1200);assert.equal(r.passedValidCases,1200,JSON.stringify(r.failures));assert.equal(r.invalidCases,36);assert.equal(r.passedInvalidRejections,36,JSON.stringify(r.failures));});
test('AXIOMA rejects fabricated Markov paths and malformed input acceptance',()=>{const r=runFinalStochasticDecisionsBank({resolveLayer:id=>id==='GAUSS.STATS.MARKOV_N_STEP.014'?{execute:()=>({distribution:[1,0]})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
