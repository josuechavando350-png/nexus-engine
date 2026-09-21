import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repair } from '../repair-agent.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const source = 'export const add = (a, b) => a - b;\n';
const spec = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../calc.mjs';\ntest('addition', () => assert.equal(add(2, 3), 5));\n";

async function fixture(t, modelBehavior = 'repair', initial = source) {
  const root = await mkdtemp(path.join(tmpdir(), 'forja-test-'));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'gauss', 'tests'), { recursive: true });
  await writeFile(path.join(repo, 'gauss/calc.mjs'), initial);
  await writeFile(path.join(repo, 'gauss/tests/calc.test.mjs'), spec);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'FORJA Test');
  git(repo, 'add', '--', 'gauss/calc.mjs', 'gauss/tests/calc.test.mjs');
  git(repo, 'commit', '-qm', 'fixture');
  const model = path.join(root, 'model.mjs');
  await writeFile(model, `let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>data+=x);process.stdin.on('end',()=>{const q=JSON.parse(data);const edit=${JSON.stringify(modelBehavior)} === 'escape' ? {path:'apps/cano-penal/src/app/page.tsx',content:'bad'} : {path:'gauss/calc.mjs',content:q.files[0].content.replace('a - b',${JSON.stringify(modelBehavior === 'no-fix' ? 'a - b' : 'a + b')})};process.stdout.write(JSON.stringify({edits:[edit]}));});\n`);
  t.after(async () => {
    const worktrees = git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(x=>x.startsWith('worktree ')).map(x=>x.slice(9));
    for (const tree of worktrees) if (tree !== repo) git(repo, 'worktree', 'remove', '--force', tree);
    await rm(root, { recursive: true, force: true });
  });
  const task = { objective: 'Fix addition using the existing test', files: ['gauss/calc.mjs'], tests: ['gauss/tests/calc.test.mjs'], model: { executable: process.execPath, args: [model] }, maxAttempts: 2 };
  return { repo, task };
}

test('repairs a real failing test in detached workspace and leaves checkout pristine', async (t) => {
  const { repo, task } = await fixture(t);
  const original = git(repo, 'rev-parse', 'HEAD');
  const result = await repair(task, repo);
  assert.equal(result.status, 'CANDIDATE_TESTS_PASS');
  assert.equal(result.attempts, 1);
  assert.match(result.diff, /\+export const add = \(a, b\) => a \+ b;/);
  assert.equal(result.revision, original);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(await readFile(path.join(repo, 'gauss/calc.mjs'), 'utf8'), source);
  assert.equal(await readFile(path.join(result.workspace, 'gauss/calc.mjs'), 'utf8'), 'export const add = (a, b) => a + b;\n');
});

test('rejects model edits to CANO without touching the protected path', async (t) => {
  const { repo, task } = await fixture(t, 'escape');
  await assert.rejects(repair(task, repo), /unsafe or oversized edit/);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('rejects a passing baseline instead of inventing a repair', async (t) => {
  const { repo, task } = await fixture(t, 'repair', 'export const add = (a, b) => a + b;\n');
  await assert.rejects(repair(task, repo), /failing baseline is required/);
});

test('returns unresolved when edits do not fix the failing test', async (t) => {
  const { repo, task } = await fixture(t, 'no-fix');
  const result = await repair(task, repo);
  assert.equal(result.status, 'REPAIR_UNRESOLVED');
  assert.equal(result.attempts, 2);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('forbids broad GAUSS source access and test edits', async (t) => {
  const { repo, task } = await fixture(t);
  await assert.rejects(repair({ ...task, files: ['apps/cano-penal/src/app/page.tsx'] }, repo), /out-of-scope/);
  await assert.rejects(repair({ ...task, files: ['gauss/tests/calc.test.mjs'] }, repo), /never editable/);
  await assert.rejects(repair({ ...task, tests: ['../package.json'] }, repo), /out-of-scope/);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('never permits editing another regression test', async (t) => {
  const { repo, task } = await fixture(t);
  await assert.rejects(repair({ ...task, files: ['gauss/tests/other.test.mjs'] }, repo), /never editable/);
});
