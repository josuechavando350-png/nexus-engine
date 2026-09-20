#!/usr/bin/env node
// Read-only, bounded verification of one durable FORJA job and its evidence.
// This is not an authenticated attestation of a host, runner, or operator.
import { spawnSync } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const STEPS = [
  ['inventory', 'AXIOMA_FORJA_GIT_TRACKED_INVENTORY', 'RECORDED'],
  ['audit', 'AXIOMA_FORJA_EXPLICIT_SUBGRAPH_AUDIT', 'PASS'],
  ['contract', 'AXIOMA_FORJA_EXECUTED_GAUSS_QUANTUM_CONTRACT', 'PASS'],
  ['consistency', 'AXIOMA_FORJA_CROSS_REPORT_CONSISTENCY', 'CONSISTENT'],
];
const STATUSES = new Set(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED', 'STALE']);
const MAX = 2 * 1024 * 1024;
function demand(ok, reason) { if (!ok) throw new Error(`FORJA_INSPECT: ${reason}`); }
async function boundedJson(path) {
  const st = await lstat(path);
  demand(st.isFile() && !st.isSymbolicLink() && st.size >= 2 && st.size <= MAX, 'unsafe evidence file');
  const bytes = await readFile(path);
  demand(bytes.length <= MAX, 'evidence exceeds byte limit');
  return JSON.parse(bytes.toString('utf8'));
}
function git(root, ...args) {
  const out = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  demand(!out.error && !out.signal && out.status === 0, 'Git identity unavailable');
  return out.stdout.trim();
}
function outside(repo, state) {
  const rel = relative(repo, state);
  return rel === '..' || rel.startsWith(`..${sep}`);
}
export async function inspectJob({ root, stateDir, id, verifySource = true }) {
  demand(typeof root === 'string' && isAbsolute(root) && typeof stateDir === 'string' && isAbsolute(stateDir), 'absolute paths required');
  demand(typeof id === 'string' && ID.test(id), 'invalid job id');
  const repo = await realpath(root);
  demand(await realpath(git(repo, 'rev-parse', '--show-toplevel')) === repo, 'repository root required');
  const state = await realpath(stateDir);
  const stateStat = await lstat(stateDir);
  demand(stateStat.isDirectory() && !stateStat.isSymbolicLink() && (stateStat.mode & 0o077) === 0 && outside(repo, state), 'private external state required');
  const job = await boundedJson(join(state, 'jobs', `${id}.json`));
  demand(job?.schemaVersion === 1 && job.id === id && SHA.test(job.sourceRevision) && STATUSES.has(job.status), 'invalid job record');
  demand(Array.isArray(job.completed) && job.completed.length <= STEPS.length &&
    job.completed.every((part, i) => part === STEPS[i][0]), 'steps must be an ordered prefix');
  demand(job.status !== 'SUCCEEDED' || job.completed.length === STEPS.length, 'success requires all steps');
  demand(job.status !== 'QUEUED' || job.completed.length === 0, 'queued job already ran steps');
  demand(job.status !== 'STALE' || job.completed.length === 0, 'stale job has executed steps');
  demand(job.status !== 'SUCCEEDED' || (typeof job.finishedAt === 'string' && job.error === null), 'inconsistent successful job');
  const artifactsDir = join(state, 'artifacts', id);
  let names;
  try {
    const directory = await lstat(artifactsDir);
    demand(directory.isDirectory() && !directory.isSymbolicLink(), 'unsafe artifact directory');
    names = await readdir(artifactsDir);
  } catch (error) {
    if (error.code !== 'ENOENT' || job.completed.length) throw error;
    names = [];
  }
  const expected = job.completed.map((part) => `${part}.json`);
  demand(names.length === expected.length && expected.every((name) => names.includes(name)), 'missing or unexpected evidence');
  const reports = {};
  for (let i = 0; i < job.completed.length; i++) {
    const [name, tool, status] = STEPS[i];
    const report = await boundedJson(join(artifactsDir, `${name}.json`));
    demand(report?.schemaVersion === 1 && report.tool === tool && report.status === status &&
      report.sourceRevision === job.sourceRevision, `invalid ${name} evidence`);
    reports[name] = report;
  }
  let checkedSourceBytes = null;
  if (job.status === 'SUCCEEDED' && verifySource) {
    demand(git(repo, 'rev-parse', 'HEAD') === job.sourceRevision, 'checkout SHA differs from job');
    demand(git(repo, 'status', '--porcelain=v1', '--untracked-files=all') === '', 'checkout is dirty');
    // Recompute independent source-byte verification; the stored JSON alone is not trusted.
    const { evaluateVerifiedFiles } = await import('./evidence-gate.mjs');
    const result = await evaluateVerifiedFiles({ root: repo,
      inventoryPath: join(artifactsDir, 'inventory.json'),
      auditPath: join(artifactsDir, 'audit.json'),
      contractPath: join(artifactsDir, 'contract.json') });
    demand(result.status === 'CONSISTENT' && result.sourceRevision === job.sourceRevision &&
      Number.isSafeInteger(result.checkedSourceBytes) && result.checkedSourceBytes > 0 &&
      reports.consistency.checkedSourceBytes === result.checkedSourceBytes,
      'recomputed evidence or source bytes do not match');
    checkedSourceBytes = result.checkedSourceBytes;
  }
  return { schemaVersion: 1, tool: 'AXIOMA_FORJA_DURABLE_JOB_INSPECTOR', status: 'PASS',
    jobId: id, sourceRevision: job.sourceRevision, jobStatus: job.status,
    verifiedReports: job.completed.length, checkedSourceBytes,
    limitations: 'Read-only consistency and local checkout verification; not signed host attestation.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, stateDir, id, ...rest] = process.argv.slice(2);
    demand(!rest.length && id, 'usage: node forja/state-inspector.mjs /abs/repo /abs/state job-id');
    process.stdout.write(`${JSON.stringify(await inspectJob({ root, stateDir, id }))}\n`);
  } catch (error) {
    console.error(String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 500));
    process.exitCode = 1;
  }
}
