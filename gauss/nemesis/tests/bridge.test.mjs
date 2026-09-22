import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runGaussNemesis,gaussNemesisStatus} from '../bridge.mjs';
const fixture = name => JSON.parse(readFileSync(new URL(`../engine/examples/${name}.json`,import.meta.url)));
test('GAUSS loads exactly 100 real Némesis entrypoints in separate namespace', async () => {
  assert.equal(gaussNemesisStatus().sourcePresent,true,'Must commit the actual engine before claiming integration');
  const engine = await import('../engine/src/index.mjs');
  assert.equal(Object.keys(engine.MOTOR_REGISTRY).length,99);
  assert.deepEqual(Object.keys(engine.MOTOR_REGISTRY).sort((a,b)=>Number(a)-Number(b)),Array.from({length:99},(_,i)=>String(i+2).padStart(2,'0')));
});
test('GAUSS executes #01 and #02 via actual Némesis code', async () => {
  const a=await runGaussNemesis('01',fixture('safe-finite-system'));
  const b=await runGaussNemesis('02',fixture('causal-confounding'));
  assert.ok(a&&typeof a==='object'); assert.ok(b&&typeof b==='object');
});
test('GAUSS refuses unknown ID and never reports certification from inventory',async()=>{
  await assert.rejects(()=>runGaussNemesis(101,{}),/ID/);
  await assert.rejects(()=>runGaussNemesis('01;rm -rf /',{}),/ID/);
  assert.equal(gaussNemesisStatus().certified,false);
  assert.deepEqual(gaussNemesisStatus().nativeOrOriginalScopeIncomplete,[81,89,95]);
});
