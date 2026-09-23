import test from 'node:test';
import assert from 'node:assert/strict';
import {gaussRegistrySummary,getGaussLayer} from '../../core/registry.mjs';
import {gaussNemesisStatus} from '../bridge.mjs';

test('GAUSS preserves its original 1000 operators; Némesis is a separate namespace',()=>{
  const summary=gaussRegistrySummary();
  assert.equal(summary.implementedLayerCount,1000);
  assert.equal(summary.targetLayerCount,1000);
  assert.equal(getGaussLayer('gauss:nemesis:89'),null,'Némesis must not impersonate a GAUSS layer');
  assert.equal(gaussNemesisStatus().namespace,'gauss:nemesis');
  assert.equal(gaussNemesisStatus().declaredEngineIds,100);
  assert.equal(gaussNemesisStatus().certified,false,'100 registered IDs cannot imply original scope certification');
});
