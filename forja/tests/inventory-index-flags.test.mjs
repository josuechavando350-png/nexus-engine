import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inventoryNexus } from '../inventory.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'forja-index-flags-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  await mkdir(join(root, 'forja'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/entry.mjs'), 'export default 1;\n');
  await writeFile(join(root, 'src/unregistered.mjs'), 'export default 1;\n');
  await writeFile(join(root, 'forja/registry.json'), JSON.stringify({ schemaVersion: 1,
    nodes: [{ id: 'entry', path: 'src/entry.mjs', kind: 'esm' }] }));
  git(root, 'add', '.');
  git(root, '-c', 'user.name=FORJA Test', '-c', 'user.email=forja@example.invalid', 'commit', '-qm', 'index fixture');
  return root;
}

for (const [flag, marker] of [['--assume-unchanged', 'h'], ['--skip-worktree', 'S']]) {
  test(`rejects ${flag} that hides changed registered bytes from git status`, async (t) => {
    const root = await fixture(t);
    git(root, 'update-index', flag, 'src/entry.mjs');
    await writeFile(join(root, 'src/entry.mjs'), 'export default 2;\n');
    assert.equal(git(root, 'status', '--porcelain=v1', '--untracked-files=all'), '',
      'Git must really hide this modified registered source');
    assert.ok(git(root, 'ls-files', '-v', '--', 'src/entry.mjs').startsWith(`${marker} `));
    await assert.rejects(inventoryNexus({ root }), /Unsupported Git index flag/);
  });
}

test('ordinary tracked index marks remain acceptable', async (t) => {
  const root = await fixture(t);
  assert.ok(git(root, 'ls-files', '-v', '--', 'src/entry.mjs').startsWith('H '));
  const report = await inventoryNexus({ root });
  assert.equal(report.status, 'RECORDED');
  assert.equal(report.counts.notAuditedSourceFiles, 1);
});

test('rejects skip-worktree on unregistered sources rather than claiming a clean tracked tree', async (t) => {
  const root = await fixture(t);
  git(root, 'update-index', '--skip-worktree', 'src/unregistered.mjs');
  await writeFile(join(root, 'src/unregistered.mjs'), 'export default 2;\n');
  assert.equal(git(root, 'status', '--porcelain=v1', '--untracked-files=all'), '');
  await assert.rejects(inventoryNexus({ root }), /Unsupported Git index flag/);
});
