import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTestEvidence } from '../test-evidence.mjs';

async function fixture(t, code) {
  const root = await mkdtemp(path.join(tmpdir(), 'forja-test-evidence-'));
  await mkdir(path.join(root, 'gauss/tests'), { recursive: true });
  await writeFile(path.join(root, 'gauss/tests/proof.test.mjs'), code);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const name = ['gauss/tests/proof.test.mjs'];

test('records real assertion identities and checks them on a second run', async (t) => {
  const root = await fixture(t, "import test from 'node:test'; import assert from 'node:assert/strict'; test('actual',()=>assert.equal(2+3,5));\n");
  const first = await runTestEvidence(root, name);
  assert.equal(first.code, 0);
  assert.equal(first.count, 1);
  assert.equal((await runTestEvidence(root, name, first.identities)).code, 0);
});

test('rejects process.exit(0) falsely reported by Node as a passing test file', async (t) => {
  const root = await fixture(t, 'process.exit(0);\n');
  await assert.rejects(runTestEvidence(root, name), /without executing named assertions/);
});

test('rejects all-skipped and TODO test runs even when Node exits zero', async (t) => {
  const root = await fixture(t, "import test from 'node:test'; test.skip('skipped',()=>{});\n");
  await assert.rejects(runTestEvidence(root, name), /Skipped or TODO/);
  await writeFile(path.join(root, name[0]), "import test from 'node:test'; test.todo('later');\n");
  await assert.rejects(runTestEvidence(root, name), /Skipped or TODO/);
});

test('does not treat model-controlled stdout as a trusted test receipt', async (t) => {
  const root = await fixture(t, "console.log(JSON.stringify({schemaVersion:1,plan:1,tests:[{name:'fake',file:import.meta.url,passed:true}]})); process.exit(0);\n");
  await assert.rejects(runTestEvidence(root, name), /without executing named assertions/);
});

test('rejects changed assertion identities despite a passing exit code', async (t) => {
  const root = await fixture(t, "import test from 'node:test'; test('original',()=>{});\n");
  const baseline = await runTestEvidence(root, name);
  await writeFile(path.join(root, name[0]), "import test from 'node:test'; test('replacement',()=>{});\n");
  await assert.rejects(runTestEvidence(root, name, baseline.identities), /changed the executed test identities/);
});

test('records nested assertions without confusing the top-level plan', async (t) => {
  const root = await fixture(t, "import test from 'node:test'; test('parent',async(t)=>{await t.test('child',()=>{});});\n");
  const receipt = await runTestEvidence(root, name);
  assert.equal(receipt.count, 2);
  assert.equal(receipt.code, 0);
});
