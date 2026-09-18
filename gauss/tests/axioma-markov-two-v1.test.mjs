import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runTwoMarkovBank} from '../axioma/markov-two-v1.mjs';
import {getGaussLayer} from '../core/registry.mjs';
test('AXIOMA independently checks 2 bounded Markov normalization/path operators',()=>{const r=runTwoMarkovBank();assert.equal(r.coveredOperators,2);assert.equal(r.validCases,200);assert.equal(r.passedValidCases,200,JSON.stringify(r.failures));assert.equal(r.invalidCases,6);assert.equal(r.passedInvalidRejections,6,JSON.stringify(r.failures));assert.deepStrictEqual(r,runTwoMarkovBank());});
test('AXIOMA catches false Markov probabilities and invalid matrix acceptance',()=>{const r=runTwoMarkovBank({resolveLayer:id=>id==='GAUSS.STATS.EXACT_MARKOV.PATH_PROBABILITY.954'?{execute:()=>({probability:'-1/1'})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
