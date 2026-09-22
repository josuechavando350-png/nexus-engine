import test from 'node:test';
import assert from 'node:assert/strict';
import {runGaussNemesis,gaussNemesisStatus} from '../bridge.mjs';

const curve={p:11,a:1,b:0,kernelX:0,points:[null,{x:0,y:0},{x:5,y:3}]};

test('81: GAUSS routes exact isogeny duality through its real Némesis bridge', async()=>{
  const result=await runGaussNemesis('81',{action:'verify-dual',payload:curve});
  assert.equal(result.verified,true);
  assert.match(result.domain,/NOT_SIGNATURE/);
  assert.equal(result.pointsChecked,curve.points.length);
  assert.deepEqual(result.doubled.slice(0,2),[null,null]);
  assert.equal(gaussNemesisStatus().certified,false);
  assert.ok(gaussNemesisStatus().nativeOrOriginalScopeIncomplete.includes(81));
});
test('81: GAUSS rejects undeclared signature actions and malformed dual requests',async()=>{
  for(const action of ['keygen','sign','verify'])
    await assert.rejects(runGaussNemesis('81',{action,payload:curve}),/expected|unsupported|must|kernel/);
  await assert.rejects(runGaussNemesis('81',{action:'verify-dual',payload:curve,secret:'no'}),/expected action and payload/);
  await assert.rejects(runGaussNemesis('81',{action:'verify-dual',payload:{...curve,p:9}}),/odd prime/);
});
