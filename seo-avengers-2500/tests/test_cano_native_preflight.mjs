import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// These are real NEXUS native modules. No simulated receipt or fake GSC data.
import { setTenantEnabled } from '../control-plane/tenant-control.mjs';
import { runTenantSidecarJob } from '../sidecar/tenant-worker.mjs';

async function isolated(t) {
  const controlRoot = await mkdtemp(join(tmpdir(), 'cano-native-control-'));
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'cano-native-evidence-'));
  t.after(async () => {
    await rm(controlRoot, { recursive: true, force: true });
    await rm(evidenceRoot, { recursive: true, force: true });
  });
  return { controlRoot, evidenceRoot, siteId: 'cano-penal' };
}

test('CANO native worker refuses absent production tenant authorization', async (t) => {
  const context = await isolated(t);
  let executed = 0;
  const result = await runTenantSidecarJob({
    ...context,
    executeSuite: async () => {
      executed += 1;
      throw new Error('UNAUTHORIZED_SUITE_MUST_NOT_EXECUTE');
    },
  });
  assert.equal(result.siteId, 'cano-penal');
  assert.equal(result.status, 'OFF');
  assert.equal(executed, 0);
  assert.equal('receipts' in result, false);
});

test('CANO native worker refuses missing first-party evidence even in an ephemeral authorized test tenant', async (t) => {
  const context = await isolated(t);
  // Authorization exists ONLY in these disposable local test directories.
  // This neither proves control of CANO's real tenant nor enables production.
  await setTenantEnabled({
    controlRoot: context.controlRoot,
    siteId: context.siteId,
    enabled: true,
    expectedGeneration: 0,
  });
  let executed = 0;
  const result = await runTenantSidecarJob({
    ...context,
    executeSuite: async () => {
      executed += 1;
      throw new Error('MISSING_EVIDENCE_MUST_NOT_EXECUTE');
    },
  });
  assert.equal(result.siteId, 'cano-penal');
  assert.equal(result.status, 'INSUFFICIENT_DATA');
  assert.equal(result.reason, 'EVIDENCE_MISSING');
  assert.equal(executed, 0);
  assert.equal('receipts' in result, false);
});
