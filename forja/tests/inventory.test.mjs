import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inventoryNexus } from '../inventory.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'forja-inventory-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  await mkdir(join(root, 'forja'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'forja/registry.json'), JSON.stringify({ schemaVersion: 1, nodes: [
    { id: 'entry', path: 'src/entry.mjs', kind: 'esm' },
  ] }));
  await writeFile(join(root, 'src/entry.mjs'), 'export default 1;\n');
  await writeFile(join(root, 'src/orphan.rs'), 'fn example() {}\n');
  await writeFile(join(root, 'package.json'), '{}\n');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=FORJA Test', '-c', 'user.email=forja@example.invalid', 'commit', '-qm', 'fixture');
  return root;
}

test('inventories tracked code but never calls an unregistered file audited', async (t) => {
  const root = await fixture(t);
  const report = await inventoryNexus({ root });
  assert.equal(report.status, 'RECORDED');
  assert.deepEqual(report.counts, { trackedFiles: 4, trackedSourceFiles: 2, registeredSourceFiles: 1,
    notAuditedSourceFiles: 1, trackedSymlinks: 0, workflows: 0, rustManifests: 0, packageManifests: 1 });
  assert.deepEqual(report.notAuditedExamples, ['src/orphan.rs']);
  assert.match(report.indexSha256, /^[a-f\d]{64}$/);
});

test('marks modified tracked source as dirty, never as verified commit bytes', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'src/entry.mjs'), 'export default 2;\n');
  assert.equal((await inventoryNexus({ root })).status, 'DIRTY_WORKTREE');
});

test('marks a new untracked file as dirty and excludes it from tracked counts', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'src/new.mjs'), 'export default 3;\n');
  const report = await inventoryNexus({ root });
  assert.equal(report.status, 'DIRTY_WORKTREE');
  assert.equal(report.counts.trackedSourceFiles, 2);
});

test('fails closed when a registry points to a source absent from Git index', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'forja/registry.json'), JSON.stringify({ schemaVersion: 1, nodes: [
    { id: 'ghost', path: 'src/ghost.mjs', kind: 'esm' },
  ] }));
  await assert.rejects(inventoryNexus({ root }), /Registered file is missing/);
});

test('counts a tracked symlink without following it', async (t) => {
  const root = await fixture(t);
  await symlink('entry.mjs', join(root, 'src/linked.mjs'));
  git(root, 'add', 'src/linked.mjs');
  git(root, '-c', 'user.name=FORJA Test', '-c', 'user.email=forja@example.invalid', 'commit', '-qm', 'link');
  const report = await inventoryNexus({ root });
  assert.equal(report.counts.trackedSymlinks, 1);
  assert.equal(report.counts.notAuditedSourceFiles, 2);
});
