import test from 'node:test';
import assert from 'node:assert/strict';
import {runGaussNemesis,gaussNemesisStatus} from '../bridge.mjs';
import {evaluateCyclicVelu} from '../isogeny-81-cyclic.mjs';
import {evaluatePublicVeluChain} from '../isogeny-81-chain.mjs';

const source={p:11,a:1,b:0,degree:2,generator:{x:0,y:0},points:[null,{x:0,y:0},{x:5,y:3}]};

test('81 GAUSS action evaluate-cyclic invokes actual algebra with exact output',async()=>{
  const result=await runGaussNemesis('81',{action:'evaluate-cyclic',payload:source});
  assert.deepEqual(result,evaluateCyclicVelu(source));
  assert.equal(result.degree,2);
  assert.match(result.domain,/NOT_SIGNATURE/);
  assert.ok(gaussNemesisStatus().nativeOrOriginalScopeIncomplete.includes(81));
});
test('81 GAUSS action evaluate-public-chain verifies each next codomain',async()=>{
  const payload={p:11,a:1,b:0,points:source.points,steps:[
    {degree:2,generator:source.generator},{degree:2,generator:source.generator}
  ]};
  const result=await runGaussNemesis(81,{action:'evaluate-public-chain',payload});
  assert.deepEqual(result,evaluatePublicVeluChain(payload));
  assert.equal(result.degreeProduct,'4');
  assert.equal(gaussNemesisStatus().certified,false);
});
test('81 new GAUSS actions reject malformed payloads and signature impersonation',async()=>{
  await assert.rejects(runGaussNemesis(81,{action:'evaluate-cyclic',payload:source,pretendSigned:true}),/expected action and payload/);
  await assert.rejects(runGaussNemesis(81,{action:'evaluate-cyclic',payload:{...source,degree:3}}),/smaller than/);
  await assert.rejects(runGaussNemesis(81,{action:'evaluate-public-chain',payload:{p:11,a:1,b:0,points:source.points,steps:[]}}),/between 1 and 16/);
  for(const action of ['keygen','sign','verify','signature'])
    await assert.rejects(runGaussNemesis(81,{action,payload:source}),/expected|must|signature|kernel/);
});
