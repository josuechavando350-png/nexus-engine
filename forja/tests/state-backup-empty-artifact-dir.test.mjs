import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSnapshot, verifySnapshot, restoreSnapshot } from '../state-backup.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'forja-empty-artifact-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  const backup = join(root, 'backup');
  await mkdir(state, { mode: 0o700 });
  await mkdir(backup, { mode: 0o700 });
  await mkdir(join(state, 'jobs'), { mode: 0o700 });
  await mkdir(join(state, 'artifacts'), { mode: 0o700 });
  await mkdir(join(state, 'approval-redemptions'), { mode: 0o700 });
  const id = randomUUID();
  await writeFile(join(state, 'jobs', `${id}.json`), `${JSON.stringify({ id, status: 'QUEUED' })}\n`, { mode: 0o600 });
  return { root, state, backup, id };
}

test('backup refuses a valid-ID empty artifact directory rather than silently losing it', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.state, 'artifacts', f.id), { mode: 0o700 });
  await assert.rejects(createSnapshot(f.state, f.backup), /empty artifact directory/);
  await assert.rejects(lstat(join(f.backup, 'snapshots', f.id)), /ENOENT/);
});

test('verify and restore reject an empty artifact directory added after snapshot publication', async (t) => {
  const f = await fixture(t);
  const saved = await createSnapshot(f.state, f.backup);
  const injected = join(f.backup, 'snapshots', saved.id, 'artifacts', f.id);
  await mkdir(injected, { mode: 0o700 });
  await assert.rejects(verifySnapshot(f.backup, saved.id), /empty artifact directory/);
  const target = join(f.root, 'restored');
  await assert.rejects(restoreSnapshot(f.backup, saved.id, target), /empty artifact directory/);
  await assert.rejects(lstat(target), /ENOENT/);
});
