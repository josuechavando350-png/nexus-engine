import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
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

test('symlinked parent cannot alias a registered source under another path', async (t) => {
  const value = await fixture(t, false);
  const { symlink } = await import('node:fs/promises');
  await symlink('src', join(value.root, 'mirror'), 'dir');
  const one = 'export const one = 1;\n';
  const nodes = [
    { id: 'one', path: 'src/one.mjs', kind: 'esm' },
    { id: 'two', path: 'mirror/one.mjs', kind: 'esm' },
  ];
  const manifest = JSON.stringify({ schemaVersion: 1, roots: ['one'], nodes, links: [] });
  await writeFile(join(value.root, 'forja/registry.json'), manifest);
  value.audit.manifestSha256 = sha256(manifest);
  value.audit.nodes[1].path = 'mirror/one.mjs';
  value.audit.nodes[1].sha256 = sha256(one);
  const result = await verifyAuditSource(value);
  assert.equal(result.status, 'MISMATCH');
  assert.ok(result.findings.some(({ code }) => code === 'SOURCE_UNAVAILABLE'));
});

test('hard-linked paths cannot count one inode twice as independent source evidence', async (t) => {
  const value = await fixture(t, false);
  await unlink(join(value.root, 'src/two.mjs'));
  await link(join(value.root, 'src/one.mjs'), join(value.root, 'src/two.mjs'));
  value.audit.nodes[1].sha256 = value.audit.nodes[0].sha256;
  const result = await verifyAuditSource(value);
  assert.equal(result.status, 'MISMATCH');
  assert.ok(result.findings.some(({ code }) => code === 'SOURCE_UNAVAILABLE'));
});

test('independent files with identical bytes are still independently verified', async (t) => {
  const value = await fixture(t, false);
  await writeFile(join(value.root, 'src/two.mjs'), 'export const one = 1;\n');
  value.audit.nodes[1].sha256 = value.audit.nodes[0].sha256;
  assert.deepEqual(await verifyAuditSource(value), { status: 'MATCH', verifiedNodes: 2, findings: [] });
});
