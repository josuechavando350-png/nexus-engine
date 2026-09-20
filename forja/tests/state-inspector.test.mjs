import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectJob } from '../state-inspector.mjs';
function git(cwd, ...args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'forja-inspect-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo'), stateDir = join(base, 'private'), id = randomUUID();
  await mkdir(root); await mkdir(join(stateDir, 'jobs'), { recursive: true, mode: 0o700 });
  await mkdir(join(stateDir, 'artifacts', id), { recursive: true, mode: 0o700 });
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'test');
  await writeFile(join(root, 'README'), 'test\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
  const job = { schemaVersion: 1, id, sourceRevision: git(root, 'rev-parse', 'HEAD'), status: 'QUEUED', completed: [], error: null };
  const save = () => writeFile(join(stateDir, 'jobs', `${id}.json`), JSON.stringify(job));
  await save();
  return { root, stateDir, id, job, save, artifact: join(stateDir, 'artifacts', id) };
}
test('queued job passes without claiming evidence or source-byte coverage', async (t) => {
  const f = await fixture(t); const result = await inspectJob(f);
  assert.equal(result.status, 'PASS'); assert.equal(result.verifiedReports, 0); assert.equal(result.checkedSourceBytes, null);
});
test('rejects duplicate, reordered, and skipped evidence steps', async (t) => {
  const f = await fixture(t); f.job.status = 'FAILED'; f.job.completed = ['audit']; await f.save();
  await assert.rejects(inspectJob(f), /ordered prefix/);
  f.job.completed = ['inventory', 'inventory']; await f.save();
  await assert.rejects(inspectJob(f), /ordered prefix/);
});
test('rejects success with incomplete evidence', async (t) => {
  const f = await fixture(t); f.job.status = 'SUCCEEDED'; await f.save();
  await assert.rejects(inspectJob(f), /success requires all steps/);
});
test('rejects artifact that is not a regular file', async (t) => {
  const f = await fixture(t); f.job.status = 'FAILED'; f.job.completed = ['inventory']; await f.save();
  await symlink('/etc/passwd', join(f.artifact, 'inventory.json'));
  await assert.rejects(inspectJob(f), /unsafe evidence file/);
});
test('rejects missing, extra, mismatched, and malformed reports', async (t) => {
  const f = await fixture(t); f.job.status = 'FAILED'; f.job.completed = ['inventory']; await f.save();
  await assert.rejects(inspectJob(f), /missing or unexpected evidence/);
  const path = join(f.artifact, 'inventory.json');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, tool: 'wrong', status: 'RECORDED', sourceRevision: f.job.sourceRevision }));
  await assert.rejects(inspectJob(f), /invalid inventory evidence/);
  await writeFile(path, JSON.stringify({ schemaVersion: 1, tool: 'AXIOMA_FORJA_GIT_TRACKED_INVENTORY', status: 'RECORDED', sourceRevision: f.job.sourceRevision }));
  assert.equal((await inspectJob(f)).verifiedReports, 1);
  await writeFile(join(f.artifact, 'surprise.json'), '{}');
  await assert.rejects(inspectJob(f), /missing or unexpected evidence/);
});
test('refuses state inside repo, permissive state, bad id, or forged SHA', async (t) => {
  const f = await fixture(t);
  await assert.rejects(inspectJob({ ...f, id: '../x' }), /invalid job id/);
  f.job.sourceRevision = '000'; await f.save();
  await assert.rejects(inspectJob(f), /invalid job record/);
  f.job.sourceRevision = git(f.root, 'rev-parse', 'HEAD'); await f.save();
  const inner = join(f.root, 'inner'); await mkdir(inner, { mode: 0o700 });
  await assert.rejects(inspectJob({ ...f, stateDir: inner }), /private external state/);
});
