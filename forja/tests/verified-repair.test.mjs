import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifiedRepair } from '../verified-repair.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const original = 'export const add = (a, b) => a - b;\nexport const subtract = (a, b) => a - b;\n';
const failing = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../calc.mjs';\ntest('addition', () => assert.equal(add(2, 3), 5));\n";
const preserving = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { subtract } from '../calc.mjs';\ntest('subtraction', () => assert.equal(subtract(5, 3), 2));\n";

async function fixture(t, behavior = 'correct', guardTest = preserving) {
  const root = await mkdtemp(path.join(tmpdir(), 'forja-verified-test-'));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'gauss/tests'), { recursive: true });
  await writeFile(path.join(repo, 'gauss/calc.mjs'), original);
  await writeFile(path.join(repo, 'gauss/tests/calc.test.mjs'), failing);
  await writeFile(path.join(repo, 'gauss/tests/subtract.test.mjs'), guardTest);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'FORJA Test');
  git(repo, 'add', '--', 'gauss');
  git(repo, 'commit', '-qm', 'fixture');
  const model = path.join(root, 'model.mjs');
  await writeFile(model, `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data', x=>s+=x);process.stdin.on('end',()=>{const task=JSON.parse(s);const content=${JSON.stringify(behavior)}==='regression' ? task.files[0].content.replaceAll('a - b', 'a + b') : task.files[0].content.replace('a - b', 'a + b');process.stdout.write(JSON.stringify({edits:[{path:'gauss/calc.mjs',content}]}))});\n`);
  t.after(async () => {
    const worktrees = git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
    for (const worktree of worktrees) if (worktree !== repo) git(repo, 'worktree', 'remove', '--force', worktree);
    await rm(root, { recursive: true, force: true });
  });
  return { repo, task: { objective: 'Fix addition without breaking subtraction', files: ['gauss/calc.mjs'],
    tests: ['gauss/tests/calc.test.mjs'], verificationTests: ['gauss/tests/subtract.test.mjs'],
    model: { executable: process.execPath, args: [model] }, maxAttempts: 1 } };
}

test('accepts a repair only when existing independent behavior remains correct', async (t) => {
  const { repo, task } = await fixture(t);
  const sha = git(repo, 'rev-parse', 'HEAD');
  const result = await verifiedRepair(task, repo);
  assert.equal(result.status, 'CANDIDATE_VERIFIED_GUARDS_PASS');
  assert.equal(result.revision, sha);
  assert.equal(result.verificationTests[0], 'gauss/tests/subtract.test.mjs');
  assert.equal(result.guardSha256['gauss/tests/subtract.test.mjs'].length, 64);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(await readFile(path.join(repo, 'gauss/calc.mjs'), 'utf8'), original);
});

test('rejects a candidate that fixes addition but breaks independent subtraction', async (t) => {
  const { repo, task } = await fixture(t, 'regression');
  const result = await verifiedRepair(task, repo);
  assert.equal(result.status, 'CANDIDATE_REJECTED_REGRESSION');
  assert.match(result.diagnostics, /subtraction|AssertionError/);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('refuses to repair while an independent verification test already fails', async (t) => {
  const badGuard = preserving.replace('subtract(5, 3), 2', 'subtract(5, 3), 999');
  const { repo, task } = await fixture(t, 'correct', badGuard);
  await assert.rejects(verifiedRepair(task, repo), /Verification baseline must pass/);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('requires distinct tracked, bounded guard tests inside GAUSS', async (t) => {
  const { repo, task } = await fixture(t);
  await assert.rejects(verifiedRepair({ ...task, verificationTests: ['gauss/tests/calc.test.mjs'] }, repo), /independent/);
  await assert.rejects(verifiedRepair({ ...task, verificationTests: ['apps/cano-penal/src/app/page.tsx'] }, repo), /Unsafe regression guard path/);
  await assert.rejects(verifiedRepair({ ...task, verificationTests: ['gauss/tests/nonexistent.test.mjs'] }, repo), /Git ls-files failed/);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});
