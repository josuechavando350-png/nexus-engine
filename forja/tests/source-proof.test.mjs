import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyAuditSource } from '../source-proof.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'forja-source-verify-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'forja'));
  await mkdir(join(root, 'src'));
  const content = 'export const actual = 42;\n';
  const manifest = JSON.stringify({ schemaVersion: 1, roots: ['actual'],
    nodes: [{ id: 'actual', path: 'src/actual.mjs', kind: 'esm' }], links: [] });
  await writeFile(join(root, 'forja/registry.json'), manifest);
  await writeFile(join(root, 'src/actual.mjs'), content);
  return { root, manifest, content, audit: { manifestSha256: digest(manifest),
    nodes: [{ id: 'actual', path: 'src/actual.mjs', sha256: digest(content) }] } };
}

test('checks actual registered source and manifest bytes', async (t) => {
  const value = await fixture(t);
  const result = await verifyAuditSource(value);
  assert.deepEqual(result, { status: 'MATCH', verifiedNodes: 1, findings: [] });
});
test('rejects a fabricated source digest', async (t) => {
  const value = await fixture(t);
  value.audit.nodes[0].sha256 = 'a'.repeat(64);
  const result = await verifyAuditSource(value);
  assert.equal(result.status, 'MISMATCH');
  assert.ok(result.findings.some((entry) => entry.code === 'SOURCE_BYTES_MISMATCH'));
});
test('rejects a source modified after the report', async (t) => {
  const value = await fixture(t);
  await writeFile(join(value.root, 'src/actual.mjs'), 'export const actual = -1;\n');
  const result = await verifyAuditSource(value);
  assert.ok(result.findings.some((entry) => entry.code === 'SOURCE_BYTES_MISMATCH'));
});
test('rejects a fabricated registry digest', async (t) => {
  const value = await fixture(t);
  value.audit.manifestSha256 = 'f'.repeat(64);
  const result = await verifyAuditSource(value);
  assert.ok(result.findings.some((entry) => entry.code === 'MANIFEST_BYTES_MISMATCH'));
});
test('rejects a report with a missing or invented registry node', async (t) => {
  const value = await fixture(t);
  value.audit.nodes[0].id = 'invented';
  const result = await verifyAuditSource(value);
  assert.ok(result.findings.some((entry) => entry.code === 'REPORTED_NODE_MISMATCH'));
});
test('rejects a symlinked registered source', async (t) => {
  const value = await fixture(t);
  await unlink(join(value.root, 'src/actual.mjs'));
  await symlink(join(value.root, 'forja/registry.json'), join(value.root, 'src/actual.mjs'));
  const result = await verifyAuditSource(value);
  assert.ok(result.findings.some((entry) => entry.code === 'SOURCE_UNAVAILABLE'));
});
test('rejects unsafe registry paths even when their hash matches', async (t) => {
  const value = await fixture(t);
  const manifest = JSON.stringify({ schemaVersion: 1, nodes: [{ id: 'actual', path: '../outside.mjs' }] });
  await writeFile(join(value.root, 'forja/registry.json'), manifest);
  value.audit.manifestSha256 = digest(manifest);
  value.audit.nodes[0].path = '../outside.mjs';
  const result = await verifyAuditSource(value);
  assert.equal(result.status, 'MISMATCH');
  assert.ok(result.findings.some((entry) => entry.code === 'REGISTRY_NODE_SET_MISMATCH'));
});
