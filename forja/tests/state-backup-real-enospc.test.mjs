import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSnapshot, restoreSnapshot, verifySnapshot } from '../state-backup.mjs';

// CI mounts a real, private 1 MiB tmpfs at this path. The tests run as the
// unprivileged runner user and must observe the kernel's actual ENOSPC error.
const volume = process.env.FORJA_ENOSPC_MOUNT;
const payload = Buffer.alloc(1536 * 1024, 0x61); // Below MAX_FILE; above tmpfs capacity.
const digest = (data) => createHash('sha256').update(data).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'forja-storage-failure-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  const backup = join(root, 'backup');
  await mkdir(state, { mode: 0o700 });
  await mkdir(backup, { mode: 0o700 });
  await mkdir(join(state, 'jobs'), { mode: 0o700 });
  const file = join(state, 'jobs', `${randomUUID()}.json`);
  await writeFile(file, payload, { mode: 0o600 });
  return { root, state, backup, file };
}

function requireVolume() {
  assert.ok(volume && volume.startsWith('/'), 'CI must supply a mounted absolute FORJA_ENOSPC_MOUNT');
}

// The capacity check prevents a silent false positive if the runner changes.
test('real full filesystem rejects snapshot without publishing partial state', async (t) => {
  requireVolume();
  const f = await fixture(t);
  const backedUp = join(volume, 'snapshot-failure');
  await mkdir(backedUp, { mode: 0o700 });
  await assert.rejects(createSnapshot(f.state, backedUp), { code: 'ENOSPC' });
  assert.deepEqual(await readdir(join(backedUp, 'snapshots')), [], 'partial snapshot must be removed');
  assert.equal(digest(await readFile(f.file)), digest(payload), 'original state must be unchanged');
  const healthy = await createSnapshot(f.state, f.backup);
  assert.equal(healthy.count, 1, 'a later snapshot must still work');
  assert.equal((await verifySnapshot(f.backup, healthy.id)).manifestSha256, healthy.manifestSha256);
});

test('real full filesystem rejects restore without exposing incomplete destination', async (t) => {
  requireVolume();
  const f = await fixture(t);
  const saved = await createSnapshot(f.state, f.backup);
  const parent = join(volume, 'restore-failure');
  await mkdir(parent, { mode: 0o700 });
  const target = join(parent, 'recovered');
  await assert.rejects(restoreSnapshot(f.backup, saved.id, target, saved.manifestSha256),
    { code: 'ENOSPC' });
  await assert.rejects(lstat(target), { code: 'ENOENT' });
  assert.deepEqual(await readdir(parent), [], 'partial restore must be removed');
  assert.equal((await verifySnapshot(f.backup, saved.id)).manifestSha256, saved.manifestSha256);
  const recovered = join(f.root, 'healthy-restore');
  assert.equal((await restoreSnapshot(f.backup, saved.id, recovered, saved.manifestSha256)).restoredFiles, 1);
  assert.equal(digest(await readFile(join(recovered, 'jobs', f.file.split('/').at(-1)))), digest(payload));
});

test('64 MiB snapshot quota rejects oversized state without publishing it', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 42; i++) {
    await writeFile(join(f.state, 'jobs', `${randomUUID()}.json`), payload, { mode: 0o600 });
  }
  // 43 x 1.5 MiB = 64.5 MiB; each file remains below the per-file limit.
  await assert.rejects(createSnapshot(f.state, f.backup), /state too large/);
  assert.deepEqual(await readdir(f.backup), [], 'no published snapshot after quota failure');
  assert.equal((await readdir(join(f.state, 'jobs'))).length, 43);
  assert.equal(digest(await readFile(f.file)), digest(payload));
});
