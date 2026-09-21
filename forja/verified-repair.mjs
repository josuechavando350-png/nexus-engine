#!/usr/bin/env node
// Independent pre/post regression gate for the bounded repair agent.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repair } from './repair-agent.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (reason) => { throw new Error(reason); };
const MAX_OUTPUT = 128 * 1024;

function guardPath(name) {
  if (typeof name !== 'string' || !/^gauss\/tests\/[a-zA-Z0-9_./-]+\.test\.mjs$/.test(name) ||
      name.split('/').some((part) => part === '' || part === '.' || part === '..')) fail('Unsafe regression guard path');
  return name;
}

async function command(executable, args, cwd, timeout = 90_000) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let bytes = 0; let exceeded = false; let settled = false;
    const timer = setTimeout(() => { exceeded = true; child.kill('SIGKILL'); }, timeout);
    const collect = (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_OUTPUT) { exceeded = true; child.kill('SIGKILL'); }
      else output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exceeded) reject(new Error('Guard subprocess timed out or exceeded output budget'));
      else resolve({ code, signal, output });
    });
  });
}

async function git(root, ...args) {
  const result = await command('git', args, root, 20_000);
  if (result.code !== 0 || result.signal) fail(`Git ${args[0]} failed: ${result.output.slice(-2000)}`);
  return args[0] === 'status' ? result.output : result.output.trim();
}

async function checkedGuardFile(root, relative) {
  let target = root;
  for (const part of relative.split('/')) {
    target = path.join(target, part);
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) fail('Guard symlink is forbidden');
  }
  const stat = await lstat(target);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) fail('Unsafe regression guard file');
  return digest(await readFile(target));
}

async function assertOnlySourceEdits(root, files) {
  const status = await git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  for (const entry of status.split('\0').filter(Boolean)) {
    if (entry.slice(0, 2) !== ' M' || !files.includes(entry.slice(3))) fail('Unexpected mutation during guard verification');
  }
}

/** Run existing passing regression guards on a clean baseline and candidate.
 * No model or tests are assumed trustworthy: execute only on a disposable unprivileged host.
 */
export async function verifiedRepair(task, repo = process.cwd()) {
  const guards = task?.verificationTests;
  if (!Array.isArray(guards) || guards.length < 1 || guards.length > 8 || new Set(guards).size !== guards.length) {
    fail('Provide 1–8 unique verificationTests');
  }
  guards.forEach(guardPath);
  if (guards.some((name) => task.tests?.includes(name))) fail('Verification tests must be independent of the failing tests');
  const root = await realpath(repo);
  if (await git(root, 'status', '--porcelain=v1', '--untracked-files=all')) fail('Source checkout must be clean');
  const revision = await git(root, 'rev-parse', 'HEAD');
  const dir = await mkdtemp(path.join(tmpdir(), 'forja-guard-'));
  const baseline = path.join(dir, 'baseline');
  let added = false;
  let guardDigests;
  try {
    await git(root, 'worktree', 'add', '--detach', baseline, revision);
    added = true;
    guardDigests = new Map();
    for (const guard of guards) {
      const tracked = await git(baseline, 'ls-files', '--error-unmatch', '--', guard);
      if (tracked !== guard) fail(`Untracked guard test: ${guard}`);
      guardDigests.set(guard, await checkedGuardFile(baseline, guard));
    }
    const pass = await command(process.execPath, ['--test', ...guards], baseline);
    await assertOnlySourceEdits(baseline, []);
    for (const guard of guards) {
      if (await checkedGuardFile(baseline, guard) !== guardDigests.get(guard)) fail('Baseline guard changed during execution');
    }
    if (pass.code !== 0 || pass.signal) fail(`Verification baseline must pass before repair: ${pass.output.slice(-2000)}`);
  } finally {
    if (added) await git(root, 'worktree', 'remove', '--force', baseline);
    await rm(dir, { recursive: true, force: true });
  }
  if (await git(root, 'rev-parse', 'HEAD') !== revision) fail('Source revision moved during baseline verification');
  const proposal = await repair(task, root);
  if (await git(root, 'status', '--porcelain=v1', '--untracked-files=all')) fail('Original checkout mutated during model execution');
  if (await git(root, 'rev-parse', 'HEAD') !== revision) fail('Source revision moved during repair');
  if (proposal.revision !== revision || proposal.status !== 'CANDIDATE_TESTS_PASS') return proposal;
  for (const guard of guards) {
    if (await checkedGuardFile(proposal.workspace, guard) !== guardDigests.get(guard)) fail(`Guard test altered: ${guard}`);
  }
  await assertOnlySourceEdits(proposal.workspace, proposal.files);
  const check = await command(process.execPath, ['--test', ...guards], proposal.workspace);
  await assertOnlySourceEdits(proposal.workspace, proposal.files);
  for (const guard of guards) {
    if (await checkedGuardFile(proposal.workspace, guard) !== guardDigests.get(guard)) fail(`Guard test altered: ${guard}`);
  }
  const diff = await git(proposal.workspace, 'diff', '--', ...proposal.files);
  // git's .trim() would remove trailing diff whitespace, so do not recalculate SHA from this output.
  // Instead ensure the candidate's previously observed diff is unchanged, byte-for-byte.
  const raw = await command('git', ['diff', '--', ...proposal.files], proposal.workspace, 20_000);
  if (raw.code !== 0 || digest(raw.output) !== proposal.diffSha256 || !diff) fail('Candidate changed during guard verification');
  if (await git(root, 'status', '--porcelain=v1', '--untracked-files=all')) fail('Original checkout mutated during guard execution');
  if (check.code !== 0 || check.signal) {
    return { status: 'CANDIDATE_REJECTED_REGRESSION', revision, workspace: proposal.workspace,
      attempts: proposal.attempts, tests: proposal.tests, verificationTests: guards,
      diffSha256: proposal.diffSha256, diagnostics: check.output.slice(-12_000) };
  }
  return { ...proposal, status: 'CANDIDATE_VERIFIED_GUARDS_PASS', verificationTests: guards,
    guardSha256: Object.fromEntries(guardDigests) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0].startsWith('--task=')) { console.error('Usage: node forja/verified-repair.mjs --task=/absolute/task.json'); process.exitCode = 2; }
  else {
    try {
      const task = JSON.parse(await readFile(args[0].slice(7), 'utf8'));
      const result = await verifiedRepair(task);
      console.log(JSON.stringify(result));
      if (result.status !== 'CANDIDATE_VERIFIED_GUARDS_PASS') process.exitCode = 1;
    } catch (error) { console.error(`FORJA VERIFIED REPAIR FAILED: ${error.message}`); process.exitCode = 2; }
  }
}
