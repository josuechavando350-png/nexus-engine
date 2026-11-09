#!/usr/bin/env node
/** Optional source registry. Does not install npm packages, run upstream code or deploy. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
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
  }).trim();
}

export function verifyRegistration(root, entries, run = git) {
  for (const entry of entries) {
    const key = `submodule.nexus-web-${entry.id}`;
    const registeredPath = run(root, ['config', '--file', '.gitmodules', '--get', `${key}.path`]);
    const registeredUrl = run(root, ['config', '--file', '.gitmodules', '--get', `${key}.url`]);
    const link = run(root, ['ls-files', '--stage', '--', entry.path]);
    if (registeredPath !== entry.path || registeredUrl !== entry.repository ||
        link !== `160000 ${entry.commit} 0\t${entry.path}`) {
      throw new Error(`Registration mismatch for ${entry.id}; refusing to fetch.`);
    }
  }
}

export function sourceState(root, entry, run = git) {
  const directory = resolve(root, entry.path);
  if (!existsSync(resolve(directory, '.git'))) return 'not-initialized';
  if (realpathSync(directory) !== directory || run(directory, ['rev-parse', '--show-toplevel']) !== directory) {
    throw new Error(`Unexpected checkout location: ${entry.id}`);
  }
  if (run(directory, ['status', '--porcelain', '--untracked-files=all'])) return 'dirty';
  if (run(directory, ['rev-parse', 'HEAD']) !== entry.commit) return 'wrong-commit';
  if (run(directory, ['rev-parse', 'HEAD:LICENSE']) !== entry.license.blob) return 'wrong-license';
  return 'verified';
}

export function initializeSources(root, entries, run = git, inspect = sourceState) {
  verifyRegistration(root, entries, run);
  for (const entry of entries) {
    if (inspect(root, entry, run) === 'dirty') {
      throw new Error(`Local changes in ${entry.id}; preserve them before updating.`);
    }
  }
  const paths = entries.map((entry) => entry.path);
  // Sync only the selected, validated URLs. Never use --remote, --force or recursive checkout.
  run(root, ['submodule', 'sync', '--', ...paths]);
  run(root, ['-c', 'protocol.file.allow=never', 'submodule', 'update', '--init', '--checkout', '--', ...paths]);
  for (const entry of entries) {
    const state = inspect(root, entry, run);
    if (state !== 'verified') throw new Error(`Checkout verification failed: ${entry.id}: ${state}`);
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
  console.log(strict || command === 'init' ? 'Sources verified; runtime integration remains opt-in.' : 'Registrations verified; uninitialized checkouts are allowed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
