import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('backup records valid empty artifact directories and restores them byte-identically', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.state, 'artifacts', f.id), { mode: 0o700 });
  const saved = await createSnapshot(f.state, f.backup);
  const manifest = JSON.parse(await readFile(join(f.backup, 'snapshots', saved.id, 'manifest.json')));
  assert.deepEqual(manifest.emptyArtifactDirs, [`artifacts/${f.id}`]);
  assert.deepEqual(await verifySnapshot(f.backup, saved.id), saved);
  const restored = join(f.root, 'restored');
  await restoreSnapshot(f.backup, saved.id, restored, saved.manifestSha256);
  const dir = await lstat(join(restored, 'artifacts', f.id));
  assert.equal(dir.isDirectory(), true);
  assert.equal(dir.mode & 0o077, 0);
  assert.equal(await readFile(join(restored, 'jobs', `${f.id}.json`), 'utf8'),
    await readFile(join(f.state, 'jobs', `${f.id}.json`), 'utf8'));
});

test('verify and restore reject a valid-ID empty artifact directory injected after snapshot publication', async (t) => {
  const f = await fixture(t);
  const saved = await createSnapshot(f.state, f.backup);
  const injected = join(f.backup, 'snapshots', saved.id, 'artifacts', f.id);
  await mkdir(injected, { recursive: true, mode: 0o700 });
  await assert.rejects(verifySnapshot(f.backup, saved.id), /snapshot directory set mismatch/);
  const target = join(f.root, 'restored');
  await assert.rejects(restoreSnapshot(f.backup, saved.id, target), /snapshot directory set mismatch/);
  await assert.rejects(lstat(target), /ENOENT/);
});

test('verify and restore reject a declared empty artifact directory deleted from snapshot', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.state, 'artifacts', f.id), { mode: 0o700 });
  const saved = await createSnapshot(f.state, f.backup);
  await rm(join(f.backup, 'snapshots', saved.id, 'artifacts', f.id), { recursive: true });
  await assert.rejects(verifySnapshot(f.backup, saved.id), /snapshot directory set mismatch/);
  await assert.rejects(restoreSnapshot(f.backup, saved.id, join(f.root, 'restored'), saved.manifestSha256),
    /snapshot directory set mismatch/);
  await assert.rejects(lstat(join(f.root, 'restored')), /ENOENT/);
});
