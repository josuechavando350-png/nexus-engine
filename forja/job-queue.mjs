#!/usr/bin/env node
// Durable, single-host, read-only FORJA evidence job queue. No arbitrary commands.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, open, lstat, readFile, readdir, realpath, rename, rm, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-f0-9-]{36}$/;
const MAX_BYTES = 2 * 1024 * 1024;
const SCRIPTS = Object.freeze([
  ['inventory', 'forja/inventory.mjs', 'AXIOMA_FORJA_GIT_TRACKED_INVENTORY', 'RECORDED'],
  ['audit', 'forja/audit.mjs', 'AXIOMA_FORJA_EXPLICIT_SUBGRAPH_AUDIT', 'PASS'],
  ['contract', 'forja/contract-probe.mjs', 'AXIOMA_FORJA_EXECUTED_GAUSS_QUANTUM_CONTRACT', 'PASS'],
  ['consistency', 'forja/evidence-gate.mjs', 'AXIOMA_FORJA_CROSS_REPORT_CONSISTENCY', 'CONSISTENT'],
]);
const rootFromSource = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function check(ok, message) { if (!ok) throw new Error(`FORJA_QUEUE: ${message}`); }
function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  check(!r.error && r.status === 0 && !r.signal, 'Git identity unavailable');
  return r.stdout.trim();
}
async function syncDir(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function atomicJson(path, object, first = false) {
  const parent = dirname(path);
  const temp = join(parent, `.forja-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(object)}\n`, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    if (first) { await link(temp, path); await unlink(temp); }
    else { await rename(temp, path); }
    await syncDir(parent);
  } finally {
    if (handle) await handle.close();
    await rm(temp, { force: true });
  }
}
async function loadJob(path) {
  const stat = await lstat(path);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_BYTES, 'unsafe job record');
  const job = JSON.parse(await readFile(path, 'utf8'));
  check(job.schemaVersion === 1 && ID.test(job.id) && path.endsWith(`${job.id}.json`) &&
    SHA.test(job.sourceRevision) && ['QUEUED','RUNNING','SUCCEEDED','FAILED','INTERRUPTED','STALE'].includes(job.status) &&
    Array.isArray(job.completed) && job.completed.every((x) => SCRIPTS.some(([name]) => name === x)), 'invalid job record');
  return job;
}
export async function queueContext({ root = rootFromSource, stateDir }) {
  check(typeof stateDir === 'string' && isAbsolute(stateDir), 'stateDir must be absolute');
  const repo = await realpath(resolve(root));
  check(await realpath(git(repo, 'rev-parse', '--show-toplevel')) === repo, 'must use repository root');
  const state = resolve(stateDir);
  const rel = relative(repo, state);
  check(rel === '..' || rel.startsWith(`..${sep}`), 'state must be outside checkout');
  await mkdir(state, { recursive: true, mode: 0o700 });
  const stat = await lstat(state);
  check(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'state directory must be private and not a symlink');
  const real = await realpath(state);
  const relReal = relative(repo, real);
  check(relReal === '..' || relReal.startsWith(`..${sep}`), 'state resolves inside checkout');
  return { repo, state: real, jobs: join(real, 'jobs'), artifacts: join(real, 'artifacts'), lock: join(real, 'worker.lock') };
}
async function prepare(ctx) {
  await mkdir(ctx.jobs, { recursive: true, mode: 0o700 });
  await mkdir(ctx.artifacts, { recursive: true, mode: 0o700 });
}
function sourceIdentity(ctx) {
  const sourceRevision = git(ctx.repo, 'rev-parse', 'HEAD');
  check(SHA.test(sourceRevision), 'invalid Git HEAD');
  check(!git(ctx.repo, 'status', '--porcelain=v1', '--untracked-files=all'), 'checkout must be clean');
  return sourceRevision;
}
export async function submitJob(ctx) {
  await prepare(ctx);
  const sourceRevision = sourceIdentity(ctx);
  const job = { schemaVersion: 1, id: randomUUID(), sourceRevision, status: 'QUEUED',
    createdAt: new Date().toISOString(), completed: [], error: null };
  await atomicJson(join(ctx.jobs, `${job.id}.json`), job, true);
  return job;
}
export async function getJob(ctx, id) {
  check(typeof id === 'string' && ID.test(id), 'invalid job id');
  return loadJob(join(ctx.jobs, `${id}.json`));
}
export async function listJobs(ctx) {
  await prepare(ctx);
  const names = (await readdir(ctx.jobs)).filter((x) => x.endsWith('.json')).sort();
  check(names.length <= 10000, 'too many jobs');
  return Promise.all(names.map((name) => loadJob(join(ctx.jobs, name))));
}
async function execute(ctx, script, args, onSpawn, timeoutMs = 120000) {
  return new Promise((resolveDone, rejectDone) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ctx.repo, detached: true,
      env: { ...process.env, FORJA_SOURCE_SHA: git(ctx.repo, 'rev-parse', 'HEAD') }, stdio: ['ignore','pipe','pipe'] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), failed = null;
    const kill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch {
        try { child.kill('SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') failed = error; }
      }
    };
    // Persist the detached process-group ID in the durable worker lock. A crash before
    // this fsync is still possible, so recovery ALSO requires an operator inspection.
    const recorded = child.pid ? Promise.resolve().then(() => onSpawn(child.pid)).catch((error) => {
      failed = error; kill();
    }) : Promise.resolve();
    const timer = setTimeout(() => { failed = new Error('step timeout'); kill(); }, timeoutMs);
    const take = (key, chunk) => {
      if (key === 'out') stdout = Buffer.concat([stdout, chunk]);
      else stderr = Buffer.concat([stderr, chunk]);
      if (stdout.length > MAX_BYTES || stderr.length > MAX_BYTES) { failed = new Error('step output exceeded limit'); kill(); }
    };
    child.stdout.on('data', (data) => take('out', data));
    child.stderr.on('data', (data) => take('err', data));
    child.once('error', (error) => { failed = error; });
    child.once('close', async (code, signal) => {
      clearTimeout(timer);
      try { await recorded; } catch (error) { failed = error; }
      if (failed || code !== 0 || signal) rejectDone(new Error(`step failed: ${failed?.message ?? `exit=${code} signal=${signal} ${stderr.toString('utf8').slice(0, 300)}`}`));
      else {
        try { resolveDone(JSON.parse(stdout.toString('utf8'))); }
        catch { rejectDone(new Error('step did not emit JSON')); }
      }
    });
  });
}
async function runJob(ctx, job, onSpawn) {
  const path = join(ctx.jobs, `${job.id}.json`);
  const save = async () => atomicJson(path, job);
  const reportDir = join(ctx.artifacts, job.id);
  await mkdir(reportDir, { mode: 0o700 });
  try {
    if (sourceIdentity(ctx) !== job.sourceRevision) { job.status = 'STALE'; job.error = 'checkout revision changed'; await save(); return job; }
    job.status = 'RUNNING'; await save();
    for (const [name, script, tool, status] of SCRIPTS) {
      check(sourceIdentity(ctx) === job.sourceRevision, 'checkout revision changed mid-run');
      const args = name === 'consistency' ? ['inventory','audit','contract'].map((part) => join(reportDir, `${part}.json`)) : [];
      const result = await execute(ctx, script, args, onSpawn);
      check(result && result.schemaVersion === 1 && result.tool === tool && result.status === status &&
        result.sourceRevision === job.sourceRevision, `${name} produced invalid or nonpassing evidence`);
      await atomicJson(join(reportDir, `${name}.json`), result, true);
      job.completed.push(name); await save();
    }
    check(sourceIdentity(ctx) === job.sourceRevision, 'checkout changed after execution');
    job.status = 'SUCCEEDED'; job.finishedAt = new Date().toISOString(); await save();
  } catch (error) {
    job.status = 'FAILED'; job.error = String(error?.message ?? error).slice(0, 500);
    job.finishedAt = new Date().toISOString(); await save();
  }
  return job;
}
export async function runNext(ctx) {
  await prepare(ctx);
  await mkdir(ctx.lock); // EEXIST: fail closed. Recover manually after proving owner dead.
  const token = randomUUID();
  const owner = { pid: process.pid, host: hostname(), token };
  let safeToRelease = false;
  try {
    await atomicJson(join(ctx.lock, 'owner.json'), owner, true);
    const queue = (await listJobs(ctx)).filter((job) => job.status === 'QUEUED')
      .sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (!queue.length) { safeToRelease = true; return null; }
    const onSpawn = async (groupPid) => {
      check(Number.isSafeInteger(groupPid) && groupPid > 0, 'invalid child process group');
      owner.activeGroupPid = groupPid;
      await atomicJson(join(ctx.lock, 'owner.json'), owner);
    };
    const result = await runJob(ctx, queue[0], onSpawn);
    // runJob returns only after persisting its terminal state. If persistence
    // fails (including the FAILED record), preserve owner/group metadata so a
    // new worker cannot proceed before explicit interrupted-job recovery.
    safeToRelease = true;
    return result;
  } finally {
    if (safeToRelease) {
      const recorded = JSON.parse(await readFile(join(ctx.lock, 'owner.json'), 'utf8').catch(() => '{}'));
      if (recorded.token === token) await rm(ctx.lock, { recursive: true, force: true });
    }
  }
}
export async function recoverInterrupted(ctx, { confirmedNoSurvivingChildren = false } = {}) {
  check(process.platform === 'linux', 'manual recovery requires Linux process-group inspection');
  check(confirmedNoSurvivingChildren === true,
    'explicit operator confirmation that all subprocesses have exited required');
  const stat = await lstat(ctx.lock);
  check(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe worker lock');
  const owner = JSON.parse(await readFile(join(ctx.lock, 'owner.json'), 'utf8'));
  check(owner.host === hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string', 'lock owner cannot be verified');
  let alive = true;
  try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
  check(!alive, 'worker owner is still alive');
  if (owner.activeGroupPid !== undefined) {
    check(Number.isSafeInteger(owner.activeGroupPid) && owner.activeGroupPid > 0,
      'invalid child process-group record');
    let groupAlive = true;
    try { process.kill(-owner.activeGroupPid, 0); }
    catch (error) { if (error.code === 'ESRCH') groupAlive = false; else throw error; }
    check(!groupAlive, 'detached subprocess group still alive; recovery denied');
  }
  const interrupted = [];
  for (const job of await listJobs(ctx)) {
    if (job.status !== 'RUNNING') continue;
    job.status = 'INTERRUPTED'; job.error = 'worker exited; no automatic replay';
    job.finishedAt = new Date().toISOString();
    await atomicJson(join(ctx.jobs, `${job.id}.json`), job);
    interrupted.push(job.id);
  }
  const again = JSON.parse(await readFile(join(ctx.lock, 'owner.json'), 'utf8'));
  check(again.token === owner.token, 'lock changed during recovery');
  await rm(ctx.lock, { recursive: true });
  return interrupted;
}
export async function serveQueue(ctx, { pollMs = 1000, signal } = {}) {
  check(Number.isSafeInteger(pollMs) && pollMs >= 100 && pollMs <= 60000, 'invalid poll interval');
  while (!signal?.aborted) {
    await runNext(ctx);
    if (signal?.aborted) break;
    await new Promise((done) => {
      const onAbort = () => { clearTimeout(timeout); done(); };
      const timeout = setTimeout(() => { signal?.removeEventListener('abort', onAbort); done(); }, pollMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, stateDir, id, ...rest] = process.argv.slice(2);
    const confirmRecovery = command === 'recover' && id === '--confirmed-no-surviving-children';
    check(!rest.length && ['submit','run','status','recover','serve'].includes(command) &&
      typeof stateDir === 'string' && (command === 'status' ? !id || ID.test(id) :
        command === 'recover' ? confirmRecovery : !id),
      'usage: node forja/job-queue.mjs submit|run|status|serve /absolute/private/state [job-id-for-status] | recover /absolute/private/state --confirmed-no-surviving-children');
    const ctx = await queueContext({ stateDir });
    if (command === 'serve') {
      const abort = new AbortController();
      process.once('SIGTERM', () => abort.abort());
      process.once('SIGINT', () => abort.abort());
      await serveQueue(ctx, { signal: abort.signal });
    } else {
      const result = command === 'submit' ? await submitJob(ctx) : command === 'run' ? await runNext(ctx) :
        command === 'status' ? (id ? await getJob(ctx,id) : await listJobs(ctx)) :
          await recoverInterrupted(ctx, { confirmedNoSurvivingChildren: confirmRecovery });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result?.status === 'FAILED' || result?.status === 'STALE') process.exitCode = 1;
    }
  } catch (error) {
    console.error(`FORJA_QUEUE_ERROR: ${String(error?.message ?? error).slice(0, 500)}`);
    process.exitCode = 2;
  }
}
