import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
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
  const root = await mkdtemp(join(tmpdir(), 'forja-inventory-hardlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  await mkdir(join(root, 'forja'));
  await mkdir(join(root, 'src'));
  const source = 'export const evidence = true;\n';
  await writeFile(join(root, 'src/one.mjs'), source);
  await writeFile(join(root, 'src/two.mjs'), source);
  await writeFile(join(root, '.gitignore'), 'ignored-copy\n');
  const nodes = ['one', 'two'].map((name) => ({ id: name, path: `src/${name}.mjs`, kind: 'esm' }));
  const manifest = JSON.stringify({ schemaVersion: 1, roots: ['one'], nodes, links: [] });
  await writeFile(join(root, 'forja/registry.json'), manifest);
  git(root, 'add', '.');
  git(root, '-c', 'user.name=FORJA Test', '-c', 'user.email=forja@example.invalid', 'commit', '-qm', 'same content separate sources');
  return { root };
}

test('two registered hard-link names are not two independent audited source files', async (t) => {
  const { root } = await fixture(t);
  await unlink(join(root, 'src/two.mjs'));
  await link(join(root, 'src/one.mjs'), join(root, 'src/two.mjs'));
  assert.equal(git(root, 'status', '--porcelain=v1', '--untracked-files=all'), '', 'Git must really consider the malicious fixture clean');
  await assert.rejects(inventoryNexus({ root }), /Registered source must be an independent regular file/);
});

test('a registered source hard-linked to an ignored name is also rejected', async (t) => {
  const { root } = await fixture(t);
  await link(join(root, 'src/one.mjs'), join(root, 'ignored-copy'));
  assert.equal(git(root, 'status', '--porcelain=v1', '--untracked-files=all'), '', 'Git must really consider ignored hard link clean');
  await assert.rejects(inventoryNexus({ root }), /Registered source must be an independent regular file/);
});

test('independent files with identical contents remain valid', async (t) => {
  const { root } = await fixture(t);
  const report = await inventoryNexus({ root });
  assert.equal(report.status, 'RECORDED');
  assert.equal(report.counts.registeredSourceFiles, 2);
});
