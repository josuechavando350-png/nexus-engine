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
  const root = await mkdtemp(join(tmpdir(), 'forja-inventory-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  await mkdir(join(root, 'forja'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/entry.mjs'), 'export default 1;\n');
  await writeFile(join(root, 'forja/registry.json'), JSON.stringify({
    schemaVersion: 1, nodes: [{ id: 'entry', path: 'src/entry.mjs', kind: 'esm' }],
  }));
  git(root, 'add', '.');
  git(root, '-c', 'user.name=FORJA Test', '-c', 'user.email=forja@example.invalid', 'commit', '-qm', 'fixture');
  return root;
}

test('registered symlink is rejected rather than reported as audited', async (t) => {
  const root = await fixture(t);
  await symlink('entry.mjs', join(root, 'src/alias.mjs'));
  await writeFile(join(root, 'forja/registry.json'), JSON.stringify({
    schemaVersion: 1, nodes: [{ id: 'entry', path: 'src/alias.mjs', kind: 'esm' }],
  }));
  git(root, 'add', '.');
  git(root, '-c', 'user.name=FORJA Test', '-c', 'user.email=forja@example.invalid', 'commit', '-qm', 'registered alias');
  await assert.rejects(inventoryNexus({ root }), /Registered source cannot be a symlink/);
});

test('unregistered symlink remains counted but NOT_AUDITED', async (t) => {
  const root = await fixture(t);
  await symlink('entry.mjs', join(root, 'src/alias.mjs'));
  git(root, 'add', '.');
  git(root, '-c', 'user.name=FORJA Test', '-c', 'user.email=forja@example.invalid', 'commit', '-qm', 'unregistered alias');
  const report = await inventoryNexus({ root });
  assert.equal(report.counts.trackedSymlinks, 1);
  assert.equal(report.counts.registeredSourceFiles, 1);
  assert.equal(report.counts.notAuditedSourceFiles, 1);
});

test('tracks .mts, .cts and .go sources as NOT_AUDITED rather than omitting them', async (t) => {
  const root = await fixture(t);
  for (const [name, bytes] of [['worker.mts', 'export const v = 1;\n'],
    ['worker.cts', 'export const v = 2;\n'], ['worker.go', 'package worker\n']]) {
    await writeFile(join(root, 'src', name), bytes);
  }
  git(root, 'add', '.');
  git(root, '-c', 'user.name=FORJA Test', '-c', 'user.email=forja@example.invalid', 'commit', '-qm', 'typed and go sources');
  const report = await inventoryNexus({ root });
  assert.equal(report.counts.trackedSourceFiles, 4);
  assert.equal(report.counts.registeredSourceFiles, 1);
  assert.equal(report.counts.notAuditedSourceFiles, 3);
  assert.deepEqual(report.notAuditedExamples, ['src/worker.cts', 'src/worker.go', 'src/worker.mts']);
});
