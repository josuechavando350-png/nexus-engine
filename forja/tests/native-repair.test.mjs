import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nativeCandidates } from '../native-transform.mjs';
import { repair } from '../repair-agent.mjs';
import { verifiedRepair } from '../verified-repair.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const initial = 'export const add = (a, b) => a - b;\nexport const subtract = (a, b) => a - b;\n';
const failing = "import test from 'node:test'; import assert from 'node:assert/strict'; import { add } from '../calc.mjs'; test('addition',()=>assert.equal(add(2,3),5));\n";
const guard = "import test from 'node:test'; import assert from 'node:assert/strict'; import { subtract } from '../calc.mjs'; test('subtraction',()=>assert.equal(subtract(5,3),2));\n";

async function fixture(t, source = initial, targetTest = failing) {
  const dir = await mkdtemp(path.join(tmpdir(), 'forja-native-test-'));
  const repo = path.join(dir, 'repo');
  await mkdir(path.join(repo, 'gauss/tests'), { recursive: true });
  await writeFile(path.join(repo, 'gauss/calc.mjs'), source);
  await writeFile(path.join(repo, 'gauss/tests/calc.test.mjs'), targetTest);
  await writeFile(path.join(repo, 'gauss/tests/guard.test.mjs'), guard);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'FORJA Native Test');
  git(repo, 'add', '--', 'gauss');
  git(repo, 'commit', '-qm', 'real failing fixture');
  t.after(async () => {
    const trees = git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((s) => s.startsWith('worktree ')).map((s) => s.slice(9));
    for (const tree of trees) if (tree !== repo) git(repo, 'worktree', 'remove', '--force', tree);
    await rm(dir, { recursive: true, force: true });
  });
  return { repo, task: { engine: 'native', objective: 'Correct a bounded, pure arithmetic operator',
    files: ['gauss/calc.mjs'], tests: ['gauss/tests/calc.test.mjs'],
    verificationTests: ['gauss/tests/guard.test.mjs'],
    native: { kind: 'pure-binary-arithmetic', exportName: 'add' } } };
}

test('native candidate generator changes only named pure arithmetic export', () => {
  const candidates = nativeCandidates(initial, { kind: 'pure-binary-arithmetic', exportName: 'add' });
  assert.deepEqual(candidates.map((c) => c.transform.to), ['+', '*', '/']);
  assert.equal(candidates[0].content, initial.replace('export const add = (a, b) => a - b;', 'export const add = (a, b) => a + b;'));
  assert.match(candidates[0].content, /export const subtract = \(a, b\) => a - b;/);
});

test('native engine repairs failing test and preserves independently passing guard without a model', async (t) => {
  const { repo, task } = await fixture(t);
  const before = git(repo, 'rev-parse', 'HEAD');
  const result = await verifiedRepair(task, repo);
  assert.equal(result.status, 'CANDIDATE_VERIFIED_GUARDS_PASS');
  assert.equal(result.engine, 'native');
  assert.equal(result.transform.from, '-');
  assert.equal(result.transform.to, '+');
  assert.equal(result.revision, before);
  assert.equal(result.attempts, 1);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(await readFile(path.join(repo, 'gauss/calc.mjs'), 'utf8'), initial);
  assert.equal(await readFile(path.join(result.workspace, 'gauss/calc.mjs'), 'utf8'), initial.replace('a - b;', 'a + b;'));
});

test('native is the default when neither a model nor an engine is configured', async (t) => {
  const { repo, task } = await fixture(t);
  const { engine, ...withoutEngine } = task;
  assert.equal(engine, 'native');
  const result = await verifiedRepair(withoutEngine, repo);
  assert.equal(result.status, 'CANDIDATE_VERIFIED_GUARDS_PASS');
  assert.equal(result.engine, 'native');
});

test('native engine searches its bounded operator family and resets after a failed candidate', async (t) => {
  const source = 'export const add = (a, b) => a + b;\nexport const subtract = (a, b) => a - b;\n';
  const target = failing.replace('add(2,3),5', 'add(2,3),6');
  const { repo, task } = await fixture(t, source, target);
  const result = await verifiedRepair(task, repo);
  assert.equal(result.status, 'CANDIDATE_VERIFIED_GUARDS_PASS');
  assert.equal(result.transform.to, '*');
  assert.equal(result.attempts, 2);
  assert.match(result.diff, /a \* b/);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('native engine refuses a proposed model executable and out-of-scope target', async (t) => {
  const { repo, task } = await fixture(t);
  await assert.rejects(repair({ ...task, model: { executable: '/bin/true', args: [] } }, repo), /no model/);
  await assert.rejects(repair({ ...task, files: ['apps/cano-penal/page.tsx'] }, repo), /out-of-scope/);
  await assert.rejects(repair({ ...task, files: ['gauss/tests/calc.test.mjs'] }, repo), /never editable/);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('native generator refuses ambiguous or non-pure source instead of guessing', () => {
  const spec = { kind: 'pure-binary-arithmetic', exportName: 'add' };
  assert.throws(() => nativeCandidates(initial + initial, spec), /unambiguous/);
  assert.throws(() => nativeCandidates('export const add = (a, b) => doOtherThing(a-b);\n', spec), /unambiguous/);
  assert.throws(() => nativeCandidates('export const add = (a, b) => b - a;\n', spec), /declared parameters/);
  assert.throws(() => nativeCandidates(initial, { ...spec, malicious: '/bin/sh' }), /requires kind/);
  assert.throws(() => nativeCandidates(initial, { ...spec, exportName: '../x' }), /requires kind/);
});

test('native repair never invents a fix when all three bounded transformations fail', async (t) => {
  const { repo, task } = await fixture(t, initial, failing.replace('add(2,3),5', 'add(2,3),999'));
  const result = await verifiedRepair(task, repo);
  assert.equal(result.status, 'REPAIR_UNRESOLVED');
  assert.equal(result.attempts, 3);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('native verification rejects pre-existing broken independent guard', async (t) => {
  const { repo, task } = await fixture(t);
  await writeFile(path.join(repo, 'gauss/tests/guard.test.mjs'), guard.replace('subtract(5,3),2', 'subtract(5,3),99'));
  git(repo, 'add', '--', 'gauss/tests/guard.test.mjs');
  git(repo, 'commit', '-qm', 'bad guard baseline');
  await assert.rejects(verifiedRepair(task, repo), /Verification baseline must pass/);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('native verification rejects a target-passing change that breaks a baseline-passing guard', async (t) => {
  const { repo, task } = await fixture(t);
  const independent = "import test from 'node:test'; import assert from 'node:assert/strict'; import { add } from '../calc.mjs'; test('legacy difference behavior',()=>assert.equal(add(5,3),2));\n";
  await writeFile(path.join(repo, 'gauss/tests/guard.test.mjs'), independent);
  git(repo, 'add', '--', 'gauss/tests/guard.test.mjs');
  git(repo, 'commit', '-qm', 'record independent behavior');
  const result = await verifiedRepair(task, repo);
  assert.equal(result.status, 'CANDIDATE_REJECTED_REGRESSION');
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('native fails closed on baseline passing and forbids non-GAUSS files', async (t) => {
  const { repo, task } = await fixture(t, initial.replace('export const add = (a, b) => a - b;', 'export const add = (a, b) => a + b;'));
  await assert.rejects(repair(task, repo), /failing baseline is required/);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});
