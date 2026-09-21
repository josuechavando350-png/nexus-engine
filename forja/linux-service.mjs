#!/usr/bin/env node
// Generate a Linux systemd --user unit; never installs it or starts a service.
// The startup guard fails closed if source, permissions or worker lock changed.
import { spawnSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const UNIT_PATH = /^\/[a-zA-Z0-9._/-]+$/;
function demand(ok, reason) { if (!ok) throw new Error(`FORJA_LINUX_SERVICE: ${reason}`); }
function outside(base, candidate) {
  const rel = relative(base, candidate);
  return rel === '..' || rel.startsWith(`..${sep}`);
}
function unitPath(path, label) {
  demand(typeof path === 'string' && isAbsolute(path) && path === resolve(path) &&
    UNIT_PATH.test(path) && !path.split('/').includes('..') && !path.split('/').includes('.'),
  `${label} must be a canonical absolute path without systemd specifiers, spaces or shell syntax`);
  return path;
}
function git(root, ...args) {
  const out = spawnSync('git', args, {cwd:root, encoding:'utf8', timeout:10000, maxBuffer:1024*1024});
  demand(!out.error && out.status === 0 && !out.signal, 'Git identity unavailable');
  return out.stdout.trim();
}
async function inspect(repoPath, statePath) {
  demand(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24 or later required');
  const root = await realpath(unitPath(repoPath, 'checkout'));
  unitPath(root, 'resolved checkout');
  demand(await realpath(git(root, 'rev-parse', '--show-toplevel')) === root, 'checkout must be repository root');
  const stateInput = unitPath(statePath, 'state');
  const stat = await lstat(stateInput);
  demand(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid()), 'state directory must be private and owned');
  const state = await realpath(stateInput);
  unitPath(state, 'resolved state');
  demand(outside(root, state) && outside(state, root), 'state must be disjoint from checkout');
  for (const file of ['job-queue.mjs', 'linux-service.mjs']) {
    const source = await lstat(join(root, 'forja', file)).catch((error) => {
      if (error.code === 'ENOENT') throw new Error(`FORJA_LINUX_SERVICE: FORJA worker entrypoint unavailable: ${file}`);
      throw error;
    });
    demand(source.isFile() && !source.isSymbolicLink(), `FORJA worker entrypoint unavailable: ${file}`);
  }
  const revision = git(root, 'rev-parse', 'HEAD');
  demand(SHA.test(revision) && git(root, 'status', '--porcelain=v1', '--untracked-files=all') === '',
    'checkout must have a clean exact Git SHA');
  return {root, state, revision};
}
export async function guardLinuxWorker(repoPath, statePath, expectedRevision) {
  demand(typeof expectedRevision === 'string' && SHA.test(expectedRevision), 'expected source SHA required');
  const ctx = await inspect(repoPath, statePath);
  demand(ctx.revision === expectedRevision, 'checkout SHA changed; regenerate and review unit');
  await lstat(join(ctx.state, 'worker.lock')).then(() => demand(false, 'worker lock exists; inspect before restart'),
    (error) => { if (error.code !== 'ENOENT') throw error; });
  return {sourceRevision:ctx.revision, state:ctx.state, status:'READY_FOR_LOCAL_READ_ONLY_WORKER'};
}
export async function renderLinuxUserUnit(repoPath, statePath, nodePath = process.execPath) {
  const ctx = await inspect(repoPath, statePath);
  const node = await realpath(unitPath(nodePath, 'Node executable'));
  unitPath(node, 'resolved Node executable');
  const executable = await lstat(node);
  demand(executable.isFile() && !executable.isSymbolicLink() && (executable.mode & 0o111) !== 0,
    'Node executable must be a real executable file');
  const script = join(ctx.root, 'forja', 'linux-service.mjs');
  const worker = join(ctx.root, 'forja', 'job-queue.mjs');
  const unit = [
    '[Unit]',
    'Description=AXIOMA FORJA local read-only evidence worker',
    'StartLimitIntervalSec=60',
    'StartLimitBurst=3',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${ctx.root}`,
    `ExecStartPre=${node} ${script} guard ${ctx.root} ${ctx.state} ${ctx.revision}`,
    `ExecStart=${node} ${worker} serve ${ctx.state}`,
    'Restart=on-failure',
    'RestartSec=10s',
    'KillSignal=SIGTERM',
    'KillMode=mixed',
    'TimeoutStopSec=600s',
    'NoNewPrivileges=true',
    'UMask=0077',
    'PrivateTmp=true',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
  return {sourceRevision:ctx.revision, state:ctx.state, unit};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, root, state, sha, ...extra] = process.argv.slice(2);
    demand((command === 'render' && root && state && !sha && !extra.length) ||
      (command === 'guard' && root && state && sha && !extra.length),
      'usage: render /abs/checkout /abs/private/state | guard /abs/checkout /abs/private/state expected-SHA');
    if (command === 'render') process.stdout.write((await renderLinuxUserUnit(root, state)).unit);
    else process.stdout.write(`${JSON.stringify(await guardLinuxWorker(root, state, sha))}\n`);
  } catch (error) {
    console.error(String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0,500));
    process.exitCode = 1;
  }
}
