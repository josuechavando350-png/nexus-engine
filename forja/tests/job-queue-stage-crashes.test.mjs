import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getJob, queueContext, recoverInterrupted, runNext, submitJob } from '../job-queue.mjs';

const stages = [
  ['inventory', 'inventory.mjs', 'AXIOMA_FORJA_GIT_TRACKED_INVENTORY', 'RECORDED'],
  ['audit', 'audit.mjs', 'AXIOMA_FORJA_EXPLICIT_SUBGRAPH_AUDIT', 'PASS'],
  ['contract', 'contract-probe.mjs', 'AXIOMA_FORJA_EXECUTED_GAUSS_QUANTUM_CONTRACT', 'PASS'],
  ['consistency', 'evidence-gate.mjs', 'AXIOMA_FORJA_CROSS_REPORT_CONSISTENCY', 'CONSISTENT'],
];
function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
}
async function waitForStage(ctx, id, marker, index, worker) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    assert.equal(worker.exitCode, null, 'worker exited before target stage');
    assert.equal(worker.signalCode, null, 'worker signaled before target stage');
    const [ownerText, markerText] = await Promise.all([
      readFile(join(ctx.lock, 'owner.json'), 'utf8').catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      }),
      readFile(marker, 'utf8').catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      }),
    ]);
    const owner = ownerText && JSON.parse(ownerText);
    const groupPid = Number(markerText);
    if (markerText && Number.isSafeInteger(groupPid) && groupPid > 0 &&
      owner?.activeGroupPid === groupPid) {
      const job = await getJob(ctx, id);
      if (job.status === 'RUNNING' && job.completed.length === index) return { owner, groupPid };
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`target stage ${stages[index][0]} never became durable and active`);
}

// The inventory crash path is covered separately by job-queue-real-crash.test.mjs.
for (const index of [1, 2, 3]) {
  test(`actual SIGKILL in ${stages[index][0]} leaves an orphan and never replays completed stages`,
    { skip: process.platform !== 'linux' }, async (t) => {
      const home = await mkdtemp(join(tmpdir(), 'forja-stage-crash-'));
      const root = join(home, 'repo');
      const stateDir = join(home, 'state');
      const marker = join(home, 'active-stage-pid');
      let worker, closed, groupPid;
      t.after(async () => {
        if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
        const markerPid = Number(await readFile(marker, 'utf8').catch(() => ''));
        const cleanupPid = groupPid || (Number.isSafeInteger(markerPid) && markerPid > 0 ? markerPid : null);
        if (cleanupPid) {
          try { process.kill(-cleanupPid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        if (closed) await closed;
        await rm(home, { recursive: true, force: true });
      });
      await mkdir(join(root, 'forja'), { recursive: true });
      for (const [step, file, tool, status] of stages) {
        const source = step === stages[index][0]
          ? `import { writeFile } from 'node:fs/promises';\nawait writeFile(process.env.FORJA_TEST_STAGE_MARKER, String(process.pid));\nsetInterval(() => {}, 1000);\n`
          : `console.log(JSON.stringify({schemaVersion:1,tool:${JSON.stringify(tool)},status:${JSON.stringify(status)},sourceRevision:process.env.FORJA_SOURCE_SHA}));\n`;
        await writeFile(join(root, 'forja', file), source);
      }
      git(root, 'init', '-q');
      git(root, 'config', 'user.email', 'forja-crash@example.invalid');
      git(root, 'config', 'user.name', 'FORJA crash test');
      git(root, 'add', '.');
      git(root, 'commit', '-qm', 'stage-specific crash fixture');
      const ctx = await queueContext({ root, stateDir });
      const queued = await submitJob(ctx);
      const moduleUrl = new URL('../job-queue.mjs', import.meta.url).href;
      const runner = `import { queueContext, runNext } from ${JSON.stringify(moduleUrl)}; await runNext(await queueContext({root:process.argv[1],stateDir:process.argv[2]}));`;
      worker = spawn(process.execPath, ['--input-type=module', '-e', runner, root, stateDir],
        { stdio: 'ignore', env: { ...process.env, FORJA_TEST_STAGE_MARKER: marker } });
      closed = new Promise((resolve) => worker.once('close', (code, signal) => resolve({ code, signal })));
      const { owner, groupPid: activePid } = await waitForStage(ctx, queued.id, marker, index, worker);
      groupPid = activePid;
      process.kill(-groupPid, 0);
      assert.equal(owner.pid, worker.pid);
      assert.equal(worker.kill('SIGKILL'), true);
      assert.equal((await closed).signal, 'SIGKILL');
      process.kill(-groupPid, 0);
      await assert.rejects(recoverInterrupted(ctx, { confirmedNoSurvivingChildren: true }),
        /detached subprocess group still alive/);
      await assert.rejects(runNext(ctx), { code: 'EEXIST' });
      const saved = await getJob(ctx, queued.id);
      assert.equal(saved.status, 'RUNNING');
      assert.deepEqual(saved.completed, stages.slice(0, index).map(([name]) => name));
      for (const [name] of stages.slice(0, index)) {
        assert.equal(JSON.parse(await readFile(join(ctx.artifacts, queued.id, `${name}.json`), 'utf8')).sourceRevision,
          queued.sourceRevision);
      }
      await assert.rejects(readFile(join(ctx.artifacts, queued.id, `${stages[index][0]}.json`)),
        { code: 'ENOENT' });
      assert.equal(JSON.parse(await readFile(join(ctx.lock, 'owner.json'), 'utf8')).activeGroupPid,
        groupPid);
    });
}
