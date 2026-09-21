#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILES = 20000;
const MAX_OUTPUT = 4 * 1024 * 1024;
const SOURCE = /\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts|rs|py|sh|go)$/i;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: MAX_OUTPUT, timeout: 20000 });
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error(`Git inventory unavailable (${args[0]})`);
  }
  return result.stdout;
}

function safeName(name) {
  return name && !name.includes('\\') && !name.includes('\0') && !isAbsolute(name) &&
    name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export async function inventoryNexus({ root }) {
  const base = resolve(root);
  const actualRoot = await realpath(base);
  const gitRoot = git(base, 'rev-parse', '--show-toplevel').toString('utf8').trim();
  if (await realpath(gitRoot) !== actualRoot) throw new Error('Inventory must run at the Git repository root');
  const head = git(base, 'rev-parse', 'HEAD').toString('utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('Invalid commit identity');
  const listing = git(base, 'ls-files', '--cached', '-z');
  if (!listing.length || listing[listing.length - 1] !== 0) throw new Error('Empty or malformed Git index');
  const filenames = listing.subarray(0, -1).toString('utf8').split('\0');
  if (filenames.length > MAX_FILES || filenames.some((name) => !safeName(name)) ||
    new Set(filenames).size !== filenames.length) throw new Error('Unsafe or excessive tracked paths');
  filenames.sort();
  // Git status intentionally suppresses modified paths marked assume-unchanged or
  // skip-worktree. Refuse any nonstandard tracked-entry mark before claiming
  // that the checked-out revision is clean and suitable for evidence.
  const marked = git(base, 'ls-files', '-v', '-z');
  if (!marked.length || marked[marked.length - 1] !== 0) throw new Error('Malformed Git index flags');
  const entries = marked.subarray(0, -1).toString('utf8').split('\0');
  const tracked = new Set(filenames);
  const observed = new Set();
  if (entries.length !== filenames.length) throw new Error('Git index flag/path mismatch');
  for (const entry of entries) {
    const name = entry.slice(2);
    if (!entry.startsWith('H ') || !tracked.has(name) || observed.has(name)) {
      throw new Error('Unsupported Git index flag or path (assume-unchanged/skip-worktree)');
    }
    observed.add(name);
  }
  const registryName = 'forja/registry.json';
  if (!filenames.includes(registryName)) throw new Error('Registry is not tracked');
  const manifest = JSON.parse(await readFile(join(base, registryName), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.nodes)) throw new Error('Malformed registry');
  const registered = new Set();
  for (const node of manifest.nodes) {
    if (!node || !safeName(node.path) || !filenames.includes(node.path) || registered.has(node.path)) {
      throw new Error('Registered file is missing, unsafe, duplicated or untracked');
    }
    registered.add(node.path);
  }
  let trackedSymlinks = 0;
  for (const name of filenames) {
    const info = await lstat(join(base, name));
    if (info.isSymbolicLink()) {
      if (registered.has(name)) throw new Error('Registered source cannot be a symlink');
      trackedSymlinks++;
      continue;
    }
    if (!info.isFile()) throw new Error('Tracked entry is not a regular file');
    // A registered source must represent its own inode, not another hard-link name.
    // Git considers equal-byte hard-link substitution clean, so status alone cannot catch it.
    if (registered.has(name) && info.nlink !== 1) {
      throw new Error('Registered source must be an independent regular file');
    }
    const real = await realpath(join(base, name));
    const rel = relative(actualRoot, real);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Tracked entry escapes repository');
  }
  const sources = filenames.filter((name) => SOURCE.test(name));
  const unregistered = sources.filter((name) => !registered.has(name));
  const clean = git(base, 'status', '--porcelain=v1', '-z', '--untracked-files=all').length === 0;
  return {
    schemaVersion: 1,
    tool: 'AXIOMA_FORJA_GIT_TRACKED_INVENTORY',
    sourceRevision: head,
    indexSha256: digest(listing),
    status: clean ? 'RECORDED' : 'DIRTY_WORKTREE',
    scope: 'tracked-paths-and-explicit-registry-only',
    counts: {
      trackedFiles: filenames.length,
      trackedSourceFiles: sources.length,
      registeredSourceFiles: sources.length - unregistered.length,
      notAuditedSourceFiles: unregistered.length,
      trackedSymlinks,
      workflows: filenames.filter((name) => name.startsWith('.github/workflows/') && /\.ya?ml$/.test(name)).length,
      rustManifests: filenames.filter((name) => name === 'Cargo.toml' || name.endsWith('/Cargo.toml')).length,
      packageManifests: filenames.filter((name) => name === 'package.json' || name.endsWith('/package.json')).length,
    },
    notAuditedExamples: unregistered.slice(0, 12),
    limitations: [
      'Git index inventory only; files outside the tracked repository are not discovered.',
      'Counting source files does not establish that they are engines, reachable or functional.',
      'Unregistered sources remain NOT_AUDITED; no automatic edge inference or full-system certification.',
      'No runtime, service, security, production or deployment monitoring is performed.',
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 2) {
    console.error('Usage: node forja/inventory.mjs');
    process.exitCode = 2;
  } else {
    try {
      const report = await inventoryNexus({ root: join(dirname(fileURLToPath(import.meta.url)), '..') });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.status !== 'RECORDED') process.exitCode = 1;
    } catch (cause) {
      console.error(`FORJA_INVENTORY_ERROR: ${cause.message}`);
      process.exitCode = 2;
    }
  }
}
