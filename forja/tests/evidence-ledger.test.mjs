import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { persistLedgerRecord, readLedgerRecord } from '../evidence-ledger.mjs';

const sha = 'a'.repeat(40);
const hex = (c) => `sha256:${c.repeat(64)}`;
function bundle() {
  return {
    consistency: { schemaVersion: 1, tool: 'AXIOMA_FORJA_CROSS_REPORT_CONSISTENCY',
      sourceRevision: sha, status: 'CONSISTENT', findings: [], checkedSourceBytes: 5 },
    walle: { schemaVersion: 1, tool: 'AXIOMA_FORJA_EXECUTED_WALLE_GAUSS_AXIOMA_CHAIN',
      sourceRevision: sha, sourceTree: 'b'.repeat(40), status: 'PASS', implementedLayers: 1000,
      reportSha256: hex('c'), axiomaSha256: hex('d'), quantumSimulation: 'CLASSICAL_ONLY' },
  };
}
async function store(t) {
  const path = await mkdtemp(join(tmpdir(), 'forja-ledger-test-'));
  t.after(async () => rm(path, { recursive: true, force: true }));
  return path;
}
const pathFor = (root, id) => join(root, `${id.slice(7)}.json`);

test('content-addresses and re-reads one complete evidence bundle', async (t) => {
  const storeRoot = await store(t);
  const captured = await persistLedgerRecord({ storeRoot, ...bundle() });
  assert.match(captured.id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(captured.status, 'RECORDED');
  const read = await readLedgerRecord({ storeRoot, id: captured.id });
  assert.equal(read.payload.sourceRevision, sha);
  assert.equal(read.payload.walle.implementedLayers, 1000);
});

test('concurrent writes of identical evidence converge without overwrite', async (t) => {
  const storeRoot = await store(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => persistLedgerRecord({ storeRoot, ...bundle() })));
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  const read = await readLedgerRecord({ storeRoot, id: results[0].id });
  assert.equal(read.payload.consistency.checkedSourceBytes, 5);
});

test('refuses incompatible source revisions', async (t) => {
  const storeRoot = await store(t);
  const data = bundle();
  data.walle.sourceRevision = 'e'.repeat(40);
  await assert.rejects(persistLedgerRecord({ storeRoot, ...data }), /WALLE evidence/);
});

test('refuses failed or unverified cross-report evidence', async (t) => {
  const storeRoot = await store(t);
  const data = bundle();
  data.consistency.checkedSourceBytes = 0;
  await assert.rejects(persistLedgerRecord({ storeRoot, ...data }), /consistency evidence/);
  data.consistency.checkedSourceBytes = 5;
  data.consistency.findings = [{ code: 'SOURCE_BYTES_MISMATCH' }];
  await assert.rejects(persistLedgerRecord({ storeRoot, ...data }), /consistency evidence/);
});

test('refuses false physical quantum or missing full operator coverage', async (t) => {
  const storeRoot = await store(t);
  const data = bundle();
  data.walle.quantumSimulation = 'PHYSICAL_QPU';
  await assert.rejects(persistLedgerRecord({ storeRoot, ...data }), /WALLE evidence/);
  data.walle.quantumSimulation = 'CLASSICAL_ONLY';
  data.walle.implementedLayers = 999;
  await assert.rejects(persistLedgerRecord({ storeRoot, ...data }), /WALLE evidence/);
});

test('detects a modified stored evidence payload', async (t) => {
  const storeRoot = await store(t);
  const { id } = await persistLedgerRecord({ storeRoot, ...bundle() });
  const file = pathFor(storeRoot, id);
  const contents = JSON.parse(await readFile(file, 'utf8'));
  contents.payload.consistency.checkedSourceBytes = 99;
  await writeFile(file, JSON.stringify(contents));
  await assert.rejects(readLedgerRecord({ storeRoot, id }), /digest mismatch/);
  await assert.rejects(persistLedgerRecord({ storeRoot, ...bundle() }), /digest mismatch/);
});

test('refuses a partial record rather than silently replacing it', async (t) => {
  const storeRoot = await store(t);
  const { id } = await persistLedgerRecord({ storeRoot, ...bundle() });
  await writeFile(pathFor(storeRoot, id), '{');
  await assert.rejects(readLedgerRecord({ storeRoot, id }));
  await assert.rejects(persistLedgerRecord({ storeRoot, ...bundle() }));
});

test('refuses symlinked ledger records and symlinked store roots', async (t) => {
  const storeRoot = await store(t);
  const { id } = await persistLedgerRecord({ storeRoot, ...bundle() });
  const record = pathFor(storeRoot, id);
  const alternate = join(storeRoot, 'real.json');
  await writeFile(alternate, await readFile(record));
  await unlink(record);
  await symlink(alternate, record);
  await assert.rejects(readLedgerRecord({ storeRoot, id }), /bounded regular file/);
  const alias = join(storeRoot, 'alias');
  await symlink(storeRoot, alias);
  await assert.rejects(persistLedgerRecord({ storeRoot: alias, ...bundle() }), /real directory/);
});

test('refuses an external-looking path whose parent symlink points inside the checkout', async (t) => {
  const temp = await store(t);
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  await symlink(repository, join(temp, 'checkout-alias'));
  await assert.rejects(persistLedgerRecord({ storeRoot: join(temp, 'checkout-alias', 'forja'), ...bundle() }), /resolved store must be outside source tree/);
});

test('refuses unsafe record identifiers', async (t) => {
  const storeRoot = await store(t);
  await assert.rejects(readLedgerRecord({ storeRoot, id: '../other' }), /invalid record identifier/);
});
