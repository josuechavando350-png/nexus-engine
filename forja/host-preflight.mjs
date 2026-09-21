#!/usr/bin/env node
// Read-only Linux self-host readiness checks; not proof of persistence or production approval.
import { spawnSync } from 'node:child_process';
import { access, lstat, realpath, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const MIN_AVAILABLE = 128n * 1024n * 1024n;
const MAX_BUFFER = 1024 * 1024;
const outside = (a, b) => { const path = relative(a, b); return path === '..' || path.startsWith(`..${sep}`); };
function demand(ok, message) { if (!ok) throw new Error(`FORJA_HOST: ${message}`); }
function git(root, ...args) {
  const output = spawnSync('git', args, {cwd:root, encoding:'utf8', timeout:10000, maxBuffer:MAX_BUFFER});
  demand(!output.error && output.status === 0 && !output.signal, 'git identity unavailable');
  return output.stdout.trim();
}
async function secureDirectory(path) {
  demand(typeof path === 'string' && isAbsolute(path), 'absolute directory required');
  const stat = await lstat(path);
  demand(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 &&
    stat.uid === process.getuid(), 'private directory must be owned by service user');
  const actual = await realpath(path);
  await access(actual, constants.R_OK | constants.W_OK | constants.X_OK);
  return actual;
}
async function freeCapacity(path) {
  const stat = await statfs(path, {bigint:true});
  const free = stat.bavail * stat.bsize;
  demand(free >= MIN_AVAILABLE && stat.ffree > 100n, 'not enough available disk bytes or inodes');
  return {availableBytes:free.toString(), availableInodes:stat.ffree.toString()};
}
export async function inspectLinuxHost({root, stateDir, backupDir, receiptsDir, keyDir, expectedRevision}) {
  demand(process.platform === 'linux', 'Linux required');
  demand(typeof process.getuid === 'function' && process.getuid() !== 0, 'dedicated unprivileged user required');
  demand(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24 or newer required');
  demand(typeof root === 'string' && isAbsolute(root), 'absolute repository root required');
  const repo = await realpath(root);
  demand(await realpath(git(repo, 'rev-parse', '--show-toplevel')) === repo, 'repository root required');
  const revision = git(repo, 'rev-parse', 'HEAD');
  demand(SHA.test(revision) && (expectedRevision === undefined ||
    (typeof expectedRevision === 'string' && SHA.test(expectedRevision) && revision === expectedRevision)),
  'source revision mismatch');
  demand(git(repo, 'status', '--porcelain=v1', '--untracked-files=all') === '', 'source checkout must be clean');
  const roots = [
    ['state', await secureDirectory(stateDir)],
    ['backup', await secureDirectory(backupDir)],
    ['receipts', await secureDirectory(receiptsDir)],
    ['keys', await secureDirectory(keyDir)],
  ];
  for (let i=0;i<roots.length;i++) {
    demand(outside(repo,roots[i][1]) && outside(roots[i][1],repo), `${roots[i][0]} overlaps checkout`);
    for (let j=0;j<i;j++) demand(outside(roots[i][1],roots[j][1]) && outside(roots[j][1],roots[i][1]),
      `${roots[i][0]} overlaps ${roots[j][0]}`);
  }
  const lock=join(roots[0][1],'worker.lock');
  try { await lstat(lock); demand(false, 'worker lock exists; inspect owner before operating'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const capacity = await freeCapacity(roots[0][1]);
  await freeCapacity(roots[1][1]);
  return {schemaVersion:1, tool:'AXIOMA_FORJA_LINUX_HOST_PREFLIGHT', status:'PASS',
    sourceRevision:revision, uid:process.getuid(), stateDir:roots[0][1], backupDir:roots[1][1],
    receiptsDir:roots[2][1], keyDir:roots[3][1], ...capacity,
    limitations:['Read-only check of ephemeral conditions; does not establish host persistence, distinct physical disks, backup freshness, operator key ownership, storage durability or production authorization.']};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    demand(process.argv.length === 7 || process.argv.length === 8,
      'usage: node forja/host-preflight.mjs /absolute/repo /absolute/state /absolute/backups /absolute/receipts /absolute/keys [expectedSHA]');
    process.stdout.write(`${JSON.stringify(await inspectLinuxHost({root:process.argv[2],stateDir:process.argv[3],
      backupDir:process.argv[4], receiptsDir:process.argv[5], keyDir:process.argv[6],expectedRevision:process.argv[7]}))}\n`);
  } catch (error) {
    console.error(String(error.message ?? error).replace(/[\r\n]+/g,' ').slice(0,500));
    process.exitCode=1;
  }
}
