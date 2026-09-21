#!/usr/bin/env node
// Bounded, test-driven GAUSS repair. A local model supplies edits; FORJA verifies them.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, open, readFile, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runTestEvidence } from './test-evidence.mjs';

const MAX_FILE = 64 * 1024;
const MAX_OUTPUT = 256 * 1024;
const safeEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8', NODE_ENV: 'test' };
const sha = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(message); };

async function run(command, args, cwd, input = '', timeoutMs = 90_000, limit = MAX_OUTPUT) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: safeEnv, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let terminated = false;
    let settled = false;
    const timer = setTimeout(() => { terminated = true; child.kill('SIGKILL'); }, timeoutMs);
    const collect = (which, chunk) => {
      if (which === 'stdout') stdout = Buffer.concat([stdout, chunk]);
      else stderr = Buffer.concat([stderr, chunk]);
      if (stdout.length > limit || stderr.length > limit) { terminated = true; child.kill('SIGKILL'); }
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminated) reject(new Error(`Process timed out or exceeded ${limit} output bytes: ${command}`));
      else resolve({ code, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    });
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE' && !settled) child.kill('SIGKILL'); });
    child.stdin.end(input);
  });
}

function checkedPath(value, prefix, suffix) {
  if (typeof value !== 'string' || !value.startsWith(prefix) || !suffix.test(value) ||
      value.includes('\\') || value.includes('\0') || value.split('/').some((part) => part === '.' || part === '..' || part === '')) {
    fail(`Unsafe or out-of-scope path: ${String(value)}`);
  }
  return value;
}

async function safeFile(root, relative) {
  let current = root;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) fail(`Symlink forbidden: ${relative}`);
  }
  const stat = await lstat(current);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE) fail(`Unsafe source file: ${relative}`);
  return current;
}

async function assertScope(workspace, allowed) {
  const status = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], workspace);
  if (status.code !== 0) fail('Unable to inspect working-tree changes');
  const entries = status.stdout.split('\0').filter(Boolean);
  for (const entry of entries) {
    const xy = entry.slice(0, 2);
    const name = entry.slice(3);
    if (xy[0] !== ' ' || !allowed.has(name) || xy[1] !== 'M') fail(`Unexpected working-tree mutation: ${JSON.stringify(entry)}`);
  }
}

async function checkedTests(workspace, tests, digests) {
  await assertScope(workspace, new Set(digests.allowed));
  for (const test of tests) {
    const file = await safeFile(workspace, test);
    if (sha(await readFile(file)) !== digests.tests.get(test)) fail(`Test altered: ${test}`);
  }
}

export async function repair(task, repo = process.cwd()) {
  const root = await realpath(repo);
  const gitRoot = await run('git', ['rev-parse', '--show-toplevel'], root);
  if (gitRoot.code !== 0 || path.resolve(gitRoot.stdout.trim()) !== root) fail('Run from the Git repository root');
  const clean = await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], root);
  if (clean.code !== 0 || clean.stdout !== '') fail('Source checkout must be clean');
  const head = await run('git', ['rev-parse', 'HEAD'], root);
  if (head.code !== 0 || !/^[0-9a-f]{40}\n?$/.test(head.stdout)) fail('Cannot resolve source revision');
  if (!task || typeof task.objective !== 'string' || !task.objective.trim() || task.objective.length > 2000) fail('A bounded objective is required');
  if (!Array.isArray(task.files) || !task.files.length || task.files.length > 8 || new Set(task.files).size !== task.files.length) fail('Provide 1–8 unique source files');
  if (!Array.isArray(task.tests) || !task.tests.length || task.tests.length > 8 || new Set(task.tests).size !== task.tests.length) fail('Provide 1–8 unique regression tests');
  const files = task.files.map((p) => checkedPath(p, 'gauss/', /\.(mjs|js|ts)$/));
  if (files.some((p) => p.startsWith('gauss/tests/'))) fail('Test files are never editable');
  const tests = task.tests.map((p) => checkedPath(p, 'gauss/tests/', /\.test\.mjs$/));
  if (files.some((p) => tests.includes(p))) fail('Tests cannot be edited');
  const maxAttempts = task.maxAttempts ?? 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) fail('maxAttempts must be 1–3');
  const model = task.model;
  if (!model || typeof model.executable !== 'string' || !path.isAbsolute(model.executable) ||
      !Array.isArray(model.args) || model.args.some((arg) => typeof arg !== 'string')) fail('An explicit local model executable and args are required');
  for (const name of [...files, ...tests]) {
    await safeFile(root, name);
    const tracked = await run('git', ['ls-files', '--error-unmatch', '--', name], root);
    if (tracked.code !== 0 || tracked.stdout.trim() !== name) fail(`File must be tracked: ${name}`);
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'forja-repair-'));
  const workspace = path.join(dir, 'checkout');
  const added = await run('git', ['worktree', 'add', '--detach', workspace, head.stdout.trim()], root);
  if (added.code !== 0) fail(`Cannot create isolated worktree: ${added.stderr}`);
  console.error(`FORJA candidate workspace: ${workspace}`);
  const digests = { allowed: files, tests: new Map() };
  for (const test of tests) digests.tests.set(test, sha(await readFile(await safeFile(workspace, test))));
  const executeTests = async (baselineIds = null) => {
    let result;
    try { result = await runTestEvidence(workspace, tests, baselineIds); }
    finally { await checkedTests(workspace, tests, digests); }
    return result;
  };
  let result = await executeTests();
  const baselineIds = result.identities;
  await assertScope(workspace, new Set()); // Baseline tests must not mutate the source.
  if (result.code === 0) fail('Regression tests already pass; a failing baseline is required');
  if (result.signal) fail(`Baseline tests terminated by signal ${result.signal}`);
  const baseline = { code: result.code, output: `${result.stdout}\n${result.stderr}`.slice(-12_000) };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const sources = [];
    for (const name of files) sources.push({ path: name, content: await readFile(await safeFile(workspace, name), 'utf8') });
    const request = JSON.stringify({ objective: task.objective, attempt, files: sources, tests, diagnostics: baseline.output }) + '\n';
    if (Buffer.byteLength(request) > MAX_OUTPUT) fail('Model request exceeds byte budget');
    const response = await run(model.executable, model.args, workspace, request, 120_000);
    if (response.code !== 0 || response.signal) fail(`Local model failed: ${response.stderr.slice(-1000)}`);
    let proposal;
    try { proposal = JSON.parse(response.stdout); } catch { fail('Model did not return valid JSON'); }
    if (!proposal || !Array.isArray(proposal.edits) || !proposal.edits.length || proposal.edits.length > files.length) fail('Model returned no valid edits');
    const seen = new Set();
    for (const edit of proposal.edits) {
      if (!edit || !files.includes(edit.path) || seen.has(edit.path) || typeof edit.content !== 'string' ||
          Buffer.byteLength(edit.content) > MAX_FILE) fail('Model attempted an unsafe or oversized edit');
      seen.add(edit.path);
    }
    for (const edit of proposal.edits) {
      const target = await safeFile(workspace, edit.path);
      const handle = await open(target, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
      try { await handle.writeFile(edit.content, 'utf8'); } finally { await handle.close(); }
    }
    await assertScope(workspace, new Set(files));
    result = await executeTests(baselineIds);
    if (result.code === 0) {
      const diff = await run('git', ['diff', '--', ...files], workspace, '', 10_000, MAX_OUTPUT);
      if (diff.code !== 0 || !diff.stdout) fail('Passing tests without a source diff');
      return { status: 'CANDIDATE_TESTS_PASS', revision: head.stdout.trim(), workspace, attempts: attempt,
        tests, files, diffSha256: sha(diff.stdout), diff: diff.stdout };
    }
    if (result.signal) fail(`Tests terminated by signal ${result.signal}`);
    baseline.output = `${result.stdout}\n${result.stderr}`.slice(-12_000);
  }
  return { status: 'REPAIR_UNRESOLVED', revision: head.stdout.trim(), workspace, attempts: maxAttempts,
    diagnostics: baseline.output };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const taskArg = process.argv.slice(2);
  if (taskArg.length !== 1 || !taskArg[0].startsWith('--task=')) {
    console.error('Usage: node forja/repair-agent.mjs --task=/absolute/task.json');
    process.exitCode = 2;
  } else {
    try {
      const task = JSON.parse(await readFile(taskArg[0].slice(7), 'utf8'));
      const result = await repair(task);
      console.log(JSON.stringify(result));
      if (result.status !== 'CANDIDATE_TESTS_PASS') process.exitCode = 1;
    } catch (error) { console.error(`FORJA FAILED: ${error.message}`); process.exitCode = 2; }
  }
}
