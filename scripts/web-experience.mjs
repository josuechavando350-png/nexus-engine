#!/usr/bin/env node
/** Optional source registry. Does not install npm packages, run upstream code or deploy. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;

export function validateCatalog(catalog) {
  if (catalog?.schemaVersion !== 1 || catalog.activation !== 'opt-in-source-only' ||
      !Array.isArray(catalog.repositories) || catalog.repositories.length === 0) {
    throw new Error('Invalid web-experience catalog.');
  }
  const ids = new Set();
  const repositories = new Set();
  for (const entry of catalog.repositories) {
    if (!entry || typeof entry.id !== 'string' || !ID.test(entry.id) || ids.has(entry.id) ||
        typeof entry.repository !== 'string' || !REPOSITORY.test(entry.repository) ||
        repositories.has(entry.repository.toLowerCase()) || !SHA.test(entry.commit ?? '') ||
        entry.path !== `vendor/web-experience/${entry.id}` || entry.license?.file !== 'LICENSE' ||
        !SHA.test(entry.license?.blob ?? '') || entry.productionStatus !== 'not-validated') {
      throw new Error(`Invalid or duplicate source entry: ${entry?.id ?? 'unknown'}`);
    }
    ids.add(entry.id);
    repositories.add(entry.repository.toLowerCase());
  }
  return catalog;
}

export function selectSources(catalog, selection = 'all') {
  validateCatalog(catalog);
  if (selection === 'all') return catalog.repositories;
  const entry = catalog.repositories.find((item) => item.id === selection);
  if (!entry) throw new Error(`Unknown source: ${selection}`);
  return [entry];
}

export function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
  }).trim();
}

/** Reject gitlinks and prove sources are excluded from the tracked FORJA inventory. */
export function verifyRegistration(root, entries, run = git) {
  const ignore = readFileSync(resolve(root, '.gitignore'), 'utf8').split(/\r?\n/);
  for (const entry of entries) {
    if (!ignore.includes(`/${entry.path}/`)) throw new Error(`Missing exact cache ignore rule: ${entry.id}`);
    if (run(root, ['ls-files', '--cached', '--', entry.path])) {
      throw new Error(`Tracked source or gitlink is forbidden: ${entry.id}`);
    }
    run(root, ['check-ignore', '--quiet', '--', `${entry.path}/.nexus-ignore-proof`]);
  }
}

/** Treat third-party clones as untrusted until commit, license and status match the lock. */
export function checkoutState(directory, entry, run = git) {
  if (!existsSync(directory)) return 'not-initialized';
  if (realpathSync(directory) !== directory || !existsSync(resolve(directory, '.git'))) {
    throw new Error(`Unexpected source checkout: ${entry.id}`);
  }
  if (run(directory, ['rev-parse', '--show-toplevel']) !== directory) {
    throw new Error(`Checkout escapes its directory: ${entry.id}`);
  }
  if (run(directory, ['status', '--porcelain', '--untracked-files=all'])) return 'dirty';
  if (run(directory, ['rev-parse', 'HEAD']) !== entry.commit) return 'wrong-commit';
  if (run(directory, ['rev-parse', 'HEAD:LICENSE']) !== entry.license.blob) return 'wrong-license';
  return 'verified';
}

export function sourceState(root, entry, run = git) {
  return checkoutState(resolve(root, entry.path), entry, run);
}

/** Pinned, opt-in clone into an ignored stage; no remote HEAD or user-work overwrite. */
export function initializeSources(root, entries, run = git, inspect = sourceState) {
  verifyRegistration(root, entries, run);
  const states = entries.map((entry) => inspect(root, entry, run));
  for (let i = 0; i < entries.length; i++) {
    if (!['not-initialized', 'verified'].includes(states[i])) {
      throw new Error(`Local source is ${states[i]}: ${entries[i].id}; no automatic overwrite.`);
    }
  }
  const sourceRoot = resolve(root, 'vendor/web-experience');
  if (realpathSync(sourceRoot) !== sourceRoot) throw new Error('Unexpected source cache root.');
  for (let i = 0; i < entries.length; i++) {
    if (states[i] === 'verified') continue;
    const entry = entries[i];
    const target = resolve(root, entry.path);
    if (existsSync(target)) throw new Error(`Source directory appeared unexpectedly: ${entry.id}`);
    const temporary = mkdtempSync(resolve(sourceRoot, `.nexus-init-${entry.id}-`));
    let published = false;
    try {
      run(root, ['-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
        'clone', '--no-checkout', '--filter=blob:none', '--', entry.repository, temporary]);
      run(temporary, ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', entry.commit]);
      const actual = checkoutState(temporary, entry, run);
      if (actual !== 'verified') throw new Error(`Checkout verification failed: ${entry.id}: ${actual}`);
      if (existsSync(target)) throw new Error(`Source directory appeared unexpectedly: ${entry.id}`);
      renameSync(temporary, target);
      published = true;
    } finally {
      if (!published) rmSync(temporary, { recursive: true, force: true });
    }
    if (inspect(root, entry, run) !== 'verified') throw new Error(`Published source verification failed: ${entry.id}`);
  }
}

export function main(argv = process.argv.slice(2), root = ROOT) {
  const [command = 'list', ...arguments_] = argv;
  if (!['list', 'verify', 'init'].includes(command)) throw new Error('Use: list | verify [id|all] [--checkout] | init [id|all]');
  const strict = arguments_.includes('--checkout');
  const positional = arguments_.filter((arg) => arg !== '--checkout');
  if (positional.length > 1 || arguments_.filter((arg) => arg === '--checkout').length > 1 ||
      (strict && command !== 'verify')) throw new Error('Invalid arguments.');
  const catalog = validateCatalog(JSON.parse(readFileSync(resolve(root, 'vendor/web-experience/catalog.json'), 'utf8')));
  const entries = selectSources(catalog, positional[0] ?? 'all');
  if (command === 'list') {
    for (const entry of entries) console.log(`${entry.id}\t${entry.commit}\t${entry.purpose}`);
    return;
  }
  verifyRegistration(root, entries);
  if (command === 'init') initializeSources(root, entries);
  for (const entry of entries) {
    const state = sourceState(root, entry);
    console.log(`${entry.id}\t${state}`);
    if (state !== 'verified' && (strict || state !== 'not-initialized')) {
      throw new Error(`Source verification failed: ${entry.id}: ${state}`);
    }
  }
  console.log(strict || command === 'init' ? 'Sources verified; runtime integration remains opt-in.' : 'Cache rules verified; uninitialized sources are allowed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
