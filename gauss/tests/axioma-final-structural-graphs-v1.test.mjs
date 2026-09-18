import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getGaussLayer} from '../core/registry.mjs';
import {runFinalStructuralGraphsBank} from '../axioma/final-structural-graphs-v1.mjs';
test('AXIOMA checks twelve structural graph algorithms against independent bounded exhaustive references',()=>{const r=runFinalStructuralGraphsBank();assert.equal(r.coveredOperators,12);assert.equal(r.validCases,1200);assert.equal(r.passedValidCases,1200,JSON.stringify(r.failures));assert.equal(r.invalidCases,36);assert.equal(r.passedInvalidRejections,36,JSON.stringify(r.failures));assert.equal(r.failedValidCases,0);assert.equal(r.failedInvalidRejections,0);});
test('AXIOMA structural graph reference catches a forged closure and permissive invalid input',()=>{const r=runFinalStructuralGraphsBank({resolveLayer:id=>id==='GAUSS.CS.DIRECTED_TRANSITIVE_CLOSURE.031'?{execute:()=>({reachable:[]})}:getGaussLayer(id)});assert.ok(r.failedValidCases>0);assert.ok(r.failedInvalidRejections>0);});
