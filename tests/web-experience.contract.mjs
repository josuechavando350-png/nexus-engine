import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { git, initializeSources, selectSources, sourceState, validateCatalog, verifyRegistration } from '../scripts/web-experience.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = () => JSON.parse(readFileSync(resolve(root, 'vendor/web-experience/catalog.json'), 'utf8'));
const entries = fixture().repositories;

function registeredRepository(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'nexus-web-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, ['init', '-q']);
  copyFileSync(resolve(root, '.gitmodules'), resolve(directory, '.gitmodules'));
  for (const entry of entries) git(directory, ['update-index', '--add', '--cacheinfo', `160000,${entry.commit},${entry.path}`]);
  return directory;
}

function mockGit(log, overrides = {}) {
  return (_root, args) => {
    log.push(args);
    if (args.includes('--get')) {
      const key = args.at(-1);
      const entry = entries.find((item) => key.startsWith(`submodule.nexus-web-${item.id}.`));
      return key.endsWith('.url') ? (overrides.url ?? entry.repository) : entry.path;
    }
    if (args[0] === 'ls-files') {
      const entry = entries.find((item) => item.path === args.at(-1));
      return `160000 ${entry.commit} 0\t${entry.path}`;
    }
    return '';
  };
}

test('registers exactly the four requested projects', () => {
  assert.deepEqual(entries.map((entry) => entry.id), ['r3f-scroll-rig', 'seam-transitions', 'photoswipe', 'embla-carousel']);
  assert.equal(validateCatalog(fixture()).repositories.length, 4);
});
test('preserves experimental status and no automatic runtime activation', () => {
  assert.equal(fixture().activation, 'opt-in-source-only');
  assert.ok(entries.every((entry) => entry.productionStatus === 'not-validated'));
});
test('records the Scroll Rig license discrepancy rather than hiding it', () => {
  assert.equal(entries[0].license.fileDeclaration, 'MIT');
  assert.equal(entries[0].license.packageDeclaration, 'ISC');
});
test('does not misrepresent SeamTransitions as an npm package', () => {
  assert.equal(entries[1].kind, 'experimental-demo-collection');
  assert.deepEqual(entries[1].packages, []);
});
for (const [name, change] of [
  ['duplicate id', (data) => { data.repositories[1].id = data.repositories[0].id; }],
  ['duplicate repository', (data) => { data.repositories[1].repository = data.repositories[0].repository; }],
  ['path traversal', (data) => { data.repositories[0].path = '../../apps'; }],
  ['invalid id', (data) => { data.repositories[0].id = '../app'; }],
  ['untrusted URL', (data) => { data.repositories[0].repository = 'https://example.com/a/b.git'; }],
  ['local protocol', (data) => { data.repositories[0].repository = 'file:///tmp/repository'; }],
  ['floating revision', (data) => { data.repositories[0].commit = 'main'; }],
  ['missing license identity', (data) => { data.repositories[0].license.blob = ''; }],
  ['automatic activation', (data) => { data.activation = 'automatic'; }],
  ['unsupported schema', (data) => { data.schemaVersion = 2; }],
  ['empty registry', (data) => { data.repositories = []; }],
]) {
  test(`rejects ${name}`, () => { const data = fixture(); change(data); assert.throws(() => validateCatalog(data)); });
}
test('selects a single project without activating others', () => {
  assert.deepEqual(selectSources(fixture(), 'photoswipe').map((entry) => entry.id), ['photoswipe']);
  assert.equal(selectSources(fixture()).length, 4);
  assert.throws(() => selectSources(fixture(), '--remote'), /Unknown source/);
});
test('verifies real gitlinks without network or npm', (t) => {
  verifyRegistration(registeredRepository(t), entries);
});
test('rejects a tampered URL before fetching', (t) => {
  const directory = registeredRepository(t);
  git(directory, ['config', '--file', '.gitmodules', 'submodule.nexus-web-photoswipe.url', 'https://example.com/not-approved.git']);
  assert.throws(() => verifyRegistration(directory, entries), /Registration mismatch/);
});
test('rejects a gitlink that differs from the locked commit', (t) => {
  const directory = registeredRepository(t);
  git(directory, ['update-index', '--cacheinfo', `160000,${'a'.repeat(40)},${entries[0].path}`]);
  assert.throws(() => verifyRegistration(directory, entries), /Registration mismatch/);
});
test('an absent checkout is not reported as installed', (t) => {
  assert.equal(sourceState(registeredRepository(t), entries[0]), 'not-initialized');
});
test('checks a real checkout, commit, license identity and local changes', (t) => {
  const directory = registeredRepository(t);
  const entry = { ...entries[0], license: { ...entries[0].license } };
  const checkout = resolve(directory, entry.path);
  mkdirSync(checkout, { recursive: true });
  git(checkout, ['init', '-q']);
  git(checkout, ['config', 'user.name', 'NEXUS local test']);
  git(checkout, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(resolve(checkout, 'LICENSE'), 'Local test fixture; not an upstream license.\n');
  git(checkout, ['add', 'LICENSE']);
  git(checkout, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'test fixture']);
  entry.commit = git(checkout, ['rev-parse', 'HEAD']);
  entry.license.blob = git(checkout, ['rev-parse', 'HEAD:LICENSE']);
  assert.equal(sourceState(directory, entry), 'verified');
  assert.equal(sourceState(directory, { ...entry, commit: 'a'.repeat(40) }), 'wrong-commit');
  assert.equal(sourceState(directory, { ...entry, license: { ...entry.license, blob: 'a'.repeat(40) } }), 'wrong-license');
  writeFileSync(resolve(checkout, 'local.txt'), 'Untracked user work');
  assert.equal(sourceState(directory, entry), 'dirty');
});
test('initialization is explicit, selected-only and never follows remote HEAD', () => {
  const log = [];
  const run = mockGit(log);
  let inspections = 0;
  initializeSources('/unused', [entries[2]], run, () => ++inspections === 1 ? 'not-initialized' : 'verified');
  const update = log.find((args) => args.includes('update'));
  assert.deepEqual(update, ['-c', 'protocol.file.allow=never', 'submodule', 'update', '--init', '--checkout', '--', entries[2].path]);
  assert.ok(!update.includes('--remote') && !update.includes('--force') && !update.includes('--recursive'));
});
test('preserves dirty checkouts instead of overwriting user work', () => {
  const log = [];
  assert.throws(() => initializeSources('/unused', [entries[0]], mockGit(log), () => 'dirty'), /Local changes/);
  assert.ok(!log.some((args) => args.includes('update')));
});
test('a failed post-fetch verification is not reported as success', () => {
  assert.throws(() => initializeSources('/unused', [entries[0]], mockGit([]), () => 'wrong-commit'), /Checkout verification failed/);
});
test('list runs offline and exposes all four pinned sources', () => {
  const output = execFileSync(process.execPath, [resolve(root, 'scripts/web-experience.mjs'), 'list'], { encoding: 'utf8' });
  for (const entry of entries) assert.ok(output.includes(entry.id) && output.includes(entry.commit));
});
test('CLI rejects unknown commands and arguments', () => {
  for (const args of [['deploy'], ['init', 'photoswipe', '--remote'], ['list', '--checkout']]) {
    assert.throws(() => execFileSync(process.execPath, [resolve(root, 'scripts/web-experience.mjs'), ...args], { stdio: 'pipe' }));
  }
});
