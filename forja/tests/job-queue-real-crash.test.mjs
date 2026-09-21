import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { getJob, queueContext, recoverInterrupted, runNext, submitJob } from '../job-queue.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
}

async function waitForDetachedStep(ctx, jobId, worker) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    assert.equal(worker.exitCode, null, 'worker exited before its detached step started');
    let owner;
    try { owner = JSON.parse(await readFile(join(ctx.lock, 'owner.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Number.isSafeInteger(owner?.activeGroupPid) && owner.activeGroupPid > 0 &&
      (await getJob(ctx, jobId)).status === 'RUNNING') return owner;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('worker did not durably record a running detached step within 15s');
}

test('actual SIGKILL leaves an orphan stage; recovery and replay fail closed while group is alive',
  { skip: process.platform !== 'linux' }, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'forja-real-crash-'));
    const root = join(home, 'checkout');
    const stateDir = join(home, 'state');
    let worker, closed, groupPid;
    t.after(async () => {
      if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
      if (groupPid) {
        try { process.kill(-groupPid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      if (closed) await closed;
      await rm(home, { recursive: true, force: true });
    });

    await mkdir(join(root, 'forja'), { recursive: true });
    // This real entrypoint stays alive until it is explicitly killed. It is a
    // test fixture, not a fake success report or a production worker.
    await writeFile(join(root, 'forja', 'inventory.mjs'), 'setInterval(() => {}, 1000);\n');
    for (const [file, tool, status] of [
      ['audit.mjs', 'AXIOMA_FORJA_EXPLICIT_SUBGRAPH_AUDIT', 'PASS'],
      ['contract-probe.mjs', 'AXIOMA_FORJA_EXECUTED_GAUSS_QUANTUM_CONTRACT', 'PASS'],
      ['evidence-gate.mjs', 'AXIOMA_FORJA_CROSS_REPORT_CONSISTENCY', 'CONSISTENT'],
    ]) {
      await writeFile(join(root, 'forja', file),
        `console.log(JSON.stringify({schemaVersion:1,tool:${JSON.stringify(tool)},status:${JSON.stringify(status)},sourceRevision:process.env.FORJA_SOURCE_SHA}));\n`);
    }
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'forja-crash@example.invalid');
    git(root, 'config', 'user.name', 'FORJA crash test');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'committed crash fixture');
    const ctx = await queueContext({ root, stateDir });
    const job = await submitJob(ctx);
    const moduleUrl = new URL('../job-queue.mjs', import.meta.url).href;
    const runner = `import { queueContext, runNext } from ${JSON.stringify(moduleUrl)}; await runNext(await queueContext({root:process.argv[1],stateDir:process.argv[2]}));`;
    worker = spawn(process.execPath, ['--input-type=module', '-e', runner, root, stateDir],
      { stdio: 'ignore' });
    closed = new Promise((resolve) => worker.once('close', (code, signal) => resolve({code, signal})));
    const owner = await waitForDetachedStep(ctx, job.id, worker);
    groupPid = owner.activeGroupPid;
    assert.equal(owner.host, hostname());
    assert.equal(owner.pid, worker.pid);
    assert.notEqual(groupPid, worker.pid, 'detached step must not share worker PID');
    process.kill(-groupPid, 0); // Actual detached step is alive before worker death.
    assert.equal(worker.kill('SIGKILL'), true);
    const result = await closed;
    assert.equal(result.signal, 'SIGKILL');
    process.kill(-groupPid, 0); // Step survives the parent SIGKILL.
    await assert.rejects(recoverInterrupted(ctx), /explicit operator confirmation/);
    await assert.rejects(recoverInterrupted(ctx, { confirmedNoSurvivingChildren: true }),
      /detached subprocess group still alive/);
    assert.equal((await getJob(ctx, job.id)).status, 'RUNNING');
    await assert.rejects(runNext(ctx), { code: 'EEXIST' });
    assert.deepEqual((await getJob(ctx, job.id)).completed, []);
    await assert.rejects(readFile(join(ctx.artifacts, job.id, 'inventory.json')),
      { code: 'ENOENT' });
    const stillLocked = JSON.parse(await readFile(join(ctx.lock, 'owner.json'), 'utf8'));
    assert.equal(stillLocked.token, owner.token, 'unsafe recovery must not replace lock ownership');
    assert.equal(stillLocked.activeGroupPid, groupPid, 'orphan identity must remain inspectable');
    // The cleanup hook kills the test-only orphan; the production recovery
    // command itself never kills children or clears this unsafe lock.
  });
