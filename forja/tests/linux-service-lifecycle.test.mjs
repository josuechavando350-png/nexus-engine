import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getJob, queueContext, submitJob } from '../job-queue.mjs';
import { guardLinuxWorker, renderLinuxUserUnit } from '../linux-service.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const worker = fileURLToPath(new URL('../job-queue.mjs', import.meta.url));
const supported = process.platform === 'linux' && typeof process.getuid === 'function' &&
  process.getuid() !== 0 && Number(process.versions.node.split('.')[0]) >= 24;

async function absent(path) {
  try { await lstat(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
async function waitForJob(ctx, id, child) {
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    assert.equal(child.exitCode, null, 'worker exited before completing job');
    assert.equal(child.signalCode, null, 'worker was terminated before completing job');
    const job = await getJob(ctx, id);
    assert.notEqual(job.status, 'FAILED', `four-stage job failed: ${job.error}`);
    assert.notEqual(job.status, 'STALE', `source changed: ${job.error}`);
    if (job.status === 'SUCCEEDED') return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`real four-stage job ${id} exceeded 90s`);
}
function launch(state) {
  const child = spawn(process.execPath, [worker, 'serve', state], {
    cwd: root, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal, stderr}));
  });
  return {child, closed};
}

test('render and guard reject a privileged service account before inspecting a checkout', async () => {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return;
  const original = process.getuid;
  try {
    process.getuid = () => 0;
    await assert.rejects(renderLinuxUserUnit('/nonexistent/repo', '/nonexistent/state'),
      /unprivileged service account required/);
    await assert.rejects(guardLinuxWorker('/nonexistent/repo', '/nonexistent/state', 'a'.repeat(40)),
      /unprivileged service account required/);
  } finally { process.getuid = original; }
});

test('real four-stage jobs succeed before and after a graceful worker restart on the same state',
  {skip: !supported}, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'forja-live-worker-'));
    const state = join(home, 'state');
    await mkdir(state, {mode:0o700});
    const children = [];
    t.after(async () => {
      for (const {child} of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.all(children.map(({closed}) => closed.catch(() => {})));
      await rm(home, {recursive:true, force:true});
    });
    const ctx = await queueContext({root, stateDir:state});
    const {sourceRevision} = await renderLinuxUserUnit(root, state);
    await guardLinuxWorker(root, state, sourceRevision);
    for (let round = 0; round < 2; round++) {
      const queued = await submitJob(ctx);
      const running = launch(state);
      children.push(running);
      const job = await waitForJob(ctx, queued.id, running.child);
      assert.equal(job.sourceRevision, sourceRevision);
      assert.deepEqual(job.completed, ['inventory', 'audit', 'contract', 'consistency']);
      const report = JSON.parse(await readFile(join(ctx.artifacts, job.id, 'consistency.json'), 'utf8'));
      assert.equal(report.status, 'CONSISTENT');
      assert.equal(report.sourceRevision, sourceRevision);
      assert.equal(report.checkedSourceBytes, 5);
      assert.equal(running.child.kill('SIGTERM'), true);
      const exit = await running.closed;
      assert.equal(exit.code, 0, `worker failed to drain: ${exit.stderr}`);
      assert.equal(exit.signal, null);
      assert.equal(await absent(join(state, 'worker.lock')), true, 'stale lock after graceful stop');
      assert.equal((await guardLinuxWorker(root, state, sourceRevision)).status,
        'READY_FOR_LOCAL_READ_ONLY_WORKER');
    }
  });
