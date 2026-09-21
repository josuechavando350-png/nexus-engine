import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getJob, queueContext, recoverInterrupted, runNext, submitJob } from '../job-queue.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const volume = process.env.FORJA_ENOSPC_MOUNT;
function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
}
async function waitForInventory(ctx, marker, worker) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    assert.equal(worker.exitCode, null, 'worker exited before storage fault');
    assert.equal(worker.signalCode, null);
    const owner = await readFile(join(ctx.lock, 'owner.json'), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const pid = await readFile(marker, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (owner && pid && JSON.parse(owner).activeGroupPid === Number(pid)) return JSON.parse(owner);
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('inventory did not reach durable process-group boundary');
}

// Use actual inventory/audit/GAUSS/Quantum/gate implementations from a committed
// checkout. Only inventory scheduling is controlled; no passing report is fabricated.
async function fixture(t, onVolume) {
  const home = await mkdtemp(join(tmpdir(), 'forja-worker-storage-'));
  const root = join(home, 'repo');
  const stateDir = await mkdtemp(join(onVolume ?? home, 'state-'));
  const marker = join(home, 'inventory-pid'), release = join(home, 'release');
  let worker, closed, owner;
  t.after(async () => {
    if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    if (owner) {
      try { process.kill(-owner.activeGroupPid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (closed) await closed;
    await rm(stateDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });
  git(home, 'clone', '--quiet', '--no-hardlinks', source, root);
  await rename(join(root, 'forja/inventory.mjs'), join(root, 'forja/inventory-implementation.mjs'));
  await writeFile(join(root, 'forja/inventory.mjs'), `
import { access, writeFile } from 'node:fs/promises';
import { inventoryNexus } from './inventory-implementation.mjs';
await writeFile(${JSON.stringify(marker)}, String(process.pid));
const deadline = Date.now() + 30000;
while (true) {
  try { await access(${JSON.stringify(release)}); break; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (Date.now() > deadline) throw new Error('test release timeout');
  await new Promise((done) => setTimeout(done, 20));
}
console.log(JSON.stringify(await inventoryNexus({ root: process.cwd() })));
`);
  git(root, 'add', 'forja');
  git(root, '-c', 'user.name=FORJA storage test', '-c', 'user.email=forja@example.invalid',
    'commit', '--quiet', '-m', 'control real inventory scheduling for storage failure');
  const ctx = await queueContext({ root, stateDir });
  const first = await submitJob(ctx), pending = await submitJob(ctx);
  // Establish ordering independently of UUID ordering if both timestamps match.
  pending.createdAt = new Date(Date.parse(first.createdAt) + 1000).toISOString();
  await writeFile(join(ctx.jobs, `${pending.id}.json`), JSON.stringify(pending));
  const moduleUrl = new URL('../job-queue.mjs', import.meta.url).href;
  const runner = `import { queueContext, runNext } from ${JSON.stringify(moduleUrl)};
try { await runNext(await queueContext({ root: process.argv[1], stateDir: process.argv[2] })); }
catch (error) { console.error(JSON.stringify({ code: error.code, message: error.message })); process.exitCode = 2; }`;
  worker = spawn(process.execPath, ['--input-type=module', '-e', runner, root, stateDir],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  worker.stderr.on('data', (chunk) => { stderr += chunk; });
  closed = new Promise((done, reject) => {
    worker.once('error', reject);
    worker.once('close', (code, signal) => done({ code, signal, stderr }));
  });
  owner = await waitForInventory(ctx, marker, worker);
  assert.equal((await getJob(ctx, first.id)).status, 'RUNNING');
  return { home, ctx, first, pending, release, closed, owner };
}

async function assertBlockedAndRecover(f, restoreStorage, expectedError) {
  await writeFile(f.release, 'continue');
  const outcome = await f.closed;
  assert.equal(outcome.code, 2, outcome.stderr);
  assert.equal(outcome.signal, null);
  assert.match(outcome.stderr, expectedError);
  assert.deepEqual(JSON.parse(await readFile(join(f.ctx.lock, 'owner.json'), 'utf8')), f.owner,
    'unpersisted failure must retain the original recoverable owner and group');
  await assert.rejects(runNext(f.ctx), { code: 'EEXIST' });
  await restoreStorage();
  assert.equal((await getJob(f.ctx, f.first.id)).status, 'RUNNING');
  assert.deepEqual((await getJob(f.ctx, f.first.id)).completed, []);
  assert.equal((await getJob(f.ctx, f.pending.id)).status, 'QUEUED');
  await assert.rejects(recoverInterrupted(f.ctx), /explicit operator confirmation/);
  await assert.rejects(lstat(join(f.ctx.artifacts, f.first.id, 'audit.json')), { code: 'ENOENT' });
  await assert.rejects(runNext(f.ctx), { code: 'EEXIST' });
  assert.deepEqual(await recoverInterrupted(f.ctx, { confirmedNoSurvivingChildren: true }), [f.first.id]);
  assert.equal((await getJob(f.ctx, f.first.id)).status, 'INTERRUPTED');
  const next = await runNext(f.ctx);
  assert.equal(next.id, f.pending.id, 'interrupted work must never be silently replayed');
  assert.equal(next.status, 'SUCCEEDED', next.error);
  assert.deepEqual(next.completed, ['inventory', 'audit', 'contract', 'consistency']);
  const gate = JSON.parse(await readFile(join(f.ctx.artifacts, next.id, 'consistency.json'), 'utf8'));
  assert.equal(gate.status, 'CONSISTENT');
  assert.equal(gate.sourceRevision, next.sourceRevision);
  assert.equal(gate.checkedSourceBytes, 5);
  await assert.rejects(lstat(f.ctx.lock), { code: 'ENOENT' });
}

test('unwritable final job record retains lock until explicit recovery; next real job succeeds',
  { skip: process.platform !== 'linux', timeout: 60000 }, async (t) => {
    const f = await fixture(t);
    const path = join(f.ctx.jobs, `${f.first.id}.json`), saved = join(f.home, 'saved-job.json');
    await rename(path, saved);
    await mkdir(path);
    await assertBlockedAndRecover(f, async () => {
      await rm(path, { recursive: true });
      await rename(saved, path);
    }, /EISDIR/);
  });

test('actual ENOSPC during active real inventory retains recovery lock and never replays',
  { skip: !volume, timeout: 60000 }, async (t) => {
    const fs = await statfs(volume);
    assert.equal(fs.type, 0x01021994, 'dedicated tmpfs is required');
    assert.ok(fs.blocks * fs.bsize <= 1024 * 1024, 'refuse to fill an unbounded filesystem');
    const f = await fixture(t, volume);
    const filler = join(f.ctx.state, 'test-disk-fill');
    const handle = await open(filler, 'wx', 0o600);
    try {
      await assert.rejects(async () => {
        for (let i = 0; i <= 256; i++) await handle.writeFile(Buffer.alloc(4096, 0x61));
        throw new Error('bounded fixture did not exhaust tmpfs');
      }, { code: 'ENOSPC' });
    } finally { await handle.close(); }
    await assertBlockedAndRecover(f, () => rm(filler), /ENOSPC/);
    await assert.rejects(lstat(join(f.ctx.artifacts, f.first.id, 'inventory.json')), { code: 'ENOENT' });
  });
