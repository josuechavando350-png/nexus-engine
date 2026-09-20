import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { challengeForJob } from '../operator-approval.mjs';
function git(root, ...args) {
  const output = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr);
  return output.stdout.trim();
}
test('queued evidence cannot obtain an operator approval challenge', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'forja-approval-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo'), stateDir = join(base, 'state');
  await mkdir(root); await mkdir(join(stateDir, 'jobs'), { recursive: true, mode: 0o700 });
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'test');
  await writeFile(join(root, 'README'), 'test\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
  const id = randomUUID();
  await writeFile(join(stateDir, 'jobs', `${id}.json`), JSON.stringify({ schemaVersion: 1,
    id, sourceRevision: git(root, 'rev-parse', 'HEAD'), status: 'QUEUED', completed: [], error: null }));
  await assert.rejects(challengeForJob({ root, stateDir, id }), /fully verified successful evidence/);
});
