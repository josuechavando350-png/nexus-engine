import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { auditNexus } from '../audit.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const audit = join(project, 'forja/audit.mjs');
const example = {
  schemaVersion: 1,
  roots: ['entry'],
  nodes: [
    { id: 'entry', path: 'entry.sh', kind: 'shell' },
    { id: 'core', path: 'src/core.mjs', kind: 'esm' },
    { id: 'worker', path: 'src/worker.mjs', kind: 'esm' },
  ],
  links: [
    { from: 'entry', to: 'core', method: 'shell-node-exec' },
    { from: 'core', to: 'worker', method: 'esm-static-import' },
  ],
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'forja-audit-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'forja'));
  await mkdir(join(root, 'src'));
  const write = async (path, text) => writeFile(join(root, path), text);
  await write('forja/registry.json', JSON.stringify(example));
  await write('entry.sh', '#!/bin/sh\nnode src/core.mjs\n');
  await write('src/core.mjs', "import './worker.mjs';\n");
  await write('src/worker.mjs', 'export const value = 1;\n');
  return { root, write };
}

test('checks the existing WALLE -> NEXUS -> GAUSS -> Quantum declared chain', async () => {
  const report = await auditNexus({ root: project });
  assert.equal(report.status, 'PASS', JSON.stringify(report.findings));
  assert.deepEqual(report.checked, {
    registeredNodes: 5, availableNodes: 5, declaredLinks: 4, evidencedLinks: 4, reachableNodes: 5,
  });
  assert.equal(report.scope, 'registered-nodes-only');
  assert.ok(report.nodes.every((node) => /^[0-9a-f]{64}$/.test(node.sha256)));
});

test('detects a missing declared import and an unreachable target', async (t) => {
  const f = await fixture(t);
  await f.write('src/core.mjs', 'export const value = 0;\n');
  const report = await auditNexus({ root: f.root });
  assert.equal(report.status, 'FAIL');
  assert.deepEqual(report.findings.map((finding) => finding.code), [
    'DECLARED_LINK_NOT_FOUND', 'REGISTERED_NODE_DISCONNECTED',
  ]);
});

test('detects missing node rather than accepting only a textual reference', async (t) => {
  const f = await fixture(t);
  await unlink(join(f.root, 'src/worker.mjs'));
  const report = await auditNexus({ root: f.root });
  assert.equal(report.status, 'FAIL');
  assert.ok(report.findings.some((finding) => finding.code === 'NODE_UNAVAILABLE'));
  assert.equal(report.checked.availableNodes, 2);
});

test('detects registered code disconnected from the declared root', async (t) => {
  const f = await fixture(t);
  const registry = structuredClone(example);
  registry.nodes.push({ id: 'orphan', path: 'src/orphan.mjs', kind: 'esm' });
  await f.write('src/orphan.mjs', 'export default 1;\n');
  await f.write('forja/registry.json', JSON.stringify(registry));
  const report = await auditNexus({ root: f.root });
  assert.deepEqual(report.findings.filter((finding) => finding.code === 'REGISTERED_NODE_DISCONNECTED')
    .map((finding) => finding.detail.id), ['orphan']);
});

test('does not accept commented, dynamic or string-only imports as the declared link', async (t) => {
  const f = await fixture(t);
  await f.write('src/core.mjs', "// import './worker.mjs';\nconst x = \"import './worker.mjs';\";\nawait import('./worker.mjs');\n");
  const report = await auditNexus({ root: f.root });
  assert.equal(report.checked.evidencedLinks, 1);
  assert.ok(report.findings.some((finding) => finding.code === 'DECLARED_LINK_NOT_FOUND'));
});

test('does not count commented-out shell execution', async (t) => {
  const f = await fixture(t);
  await f.write('entry.sh', '# node src/core.mjs\necho not-executed\n');
  const report = await auditNexus({ root: f.root });
  assert.equal(report.checked.evidencedLinks, 1);
  assert.equal(report.status, 'FAIL');
});

test('rejects duplicate identifiers and unknown edge endpoints', async (t) => {
  const f = await fixture(t);
  const registry = structuredClone(example);
  registry.nodes[1].id = 'entry';
  await f.write('forja/registry.json', JSON.stringify(registry));
  await assert.rejects(auditNexus({ root: f.root }), /duplicate node id/);
  registry.nodes[1].id = 'core';
  registry.links[0].to = 'unknown';
  await f.write('forja/registry.json', JSON.stringify(registry));
  await assert.rejects(auditNexus({ root: f.root }), /Invalid link/);
});

test('rejects repository traversal and unsafe paths in registry', async (t) => {
  const f = await fixture(t);
  const registry = structuredClone(example);
  registry.nodes[1].path = '../outside.mjs';
  await f.write('forja/registry.json', JSON.stringify(registry));
  await assert.rejects(auditNexus({ root: f.root }), /Invalid repository-relative path/);
});

test('rejects symlinks pointing outside the repository', async (t) => {
  const f = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'forja-external-'));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'worker.mjs'), 'export default true;\n');
  await unlink(join(f.root, 'src/worker.mjs'));
  await symlink(join(outside, 'worker.mjs'), join(f.root, 'src/worker.mjs'));
  const report = await auditNexus({ root: f.root });
  assert.ok(report.findings.some((finding) => finding.code === 'NODE_UNAVAILABLE'));
});

test('rejects oversized inputs and malformed manifests', async (t) => {
  const f = await fixture(t);
  await f.write('src/core.mjs', 'x'.repeat(2097153));
  const report = await auditNexus({ root: f.root });
  assert.equal(report.status, 'FAIL');
  assert.ok(report.findings.some((finding) => finding.code === 'NODE_UNAVAILABLE'));
  await f.write('forja/registry.json', '{');
  await assert.rejects(auditNexus({ root: f.root }), SyntaxError);
});

test('CLI returns nonzero and machine-readable FAIL when a declared link breaks', async (t) => {
  const f = await fixture(t);
  await f.write('src/core.mjs', 'export default null;\n');
  const result = spawnSync(process.execPath, [audit, '--root', f.root], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'FAIL');
});

test('same files yield stable fingerprints and no invented commit', async (t) => {
  const f = await fixture(t);
  const first = await auditNexus({ root: f.root });
  const second = await auditNexus({ root: f.root });
  assert.deepEqual(first, second);
  assert.equal(first.sourceRevision, null);
  assert.equal((await readFile(join(f.root, 'src/core.mjs'), 'utf8')).trim(), "import './worker.mjs';");
});
