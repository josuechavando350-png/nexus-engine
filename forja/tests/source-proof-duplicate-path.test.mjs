import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyAuditSource } from '../source-proof.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function fixture(t, duplicatePath) {
  const root = await mkdtemp(join(tmpdir(), 'forja-duplicate-source-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'forja'));
  await mkdir(join(root, 'src'));
  const one = 'export const one = 1;\n';
  const two = 'export const two = 2;\n';
  await writeFile(join(root, 'src/one.mjs'), one);
  await writeFile(join(root, 'src/two.mjs'), two);
  const nodes = [
    { id: 'one', path: 'src/one.mjs', kind: 'esm' },
    { id: 'two', path: duplicatePath ? 'src/one.mjs' : 'src/two.mjs', kind: 'esm' },
  ];
  const manifest = JSON.stringify({ schemaVersion: 1, roots: ['one'], nodes, links: [] });
  await writeFile(join(root, 'forja/registry.json'), manifest);
  const audit = { manifestSha256: sha256(manifest), nodes: nodes.map((node) => ({
    id: node.id, path: node.path, sha256: sha256(node.path === 'src/one.mjs' ? one : two),
  })) };
  return { root, audit };
}

test('distinct registered source paths verify independently', async (t) => {
  const result = await verifyAuditSource(await fixture(t, false));
  assert.deepEqual(result, { status: 'MATCH', verifiedNodes: 2, findings: [] });
});

test('duplicate registry paths cannot count one source twice as independently verified', async (t) => {
  const result = await verifyAuditSource(await fixture(t, true));
  assert.equal(result.status, 'MISMATCH');
  assert.ok(result.findings.some(({ code }) => code === 'REGISTRY_NODE_SET_MISMATCH'));
});
