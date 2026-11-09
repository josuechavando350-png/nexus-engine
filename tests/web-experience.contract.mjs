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
  copyFileSync(resolve(root, '.gitignore'), resolve(directory, '.gitignore'));
  mkdirSync(resolve(directory, 'vendor/web-experience'), { recursive: true });
  return directory;
}

function simulatedClone(log, entry) {
  return (cwd, args) => {
    log.push({ cwd, args });
    if (args.includes('clone')) {
      assert.equal(args.at(-2), entry.repository);
      mkdirSync(resolve(args.at(-1), '.git'));
      return '';
    }
    if (args.includes('checkout')) {
      assert.deepEqual(args.slice(-3), ['checkout', '--detach', entry.commit]);
      return '';
    }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return cwd;
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return entry.commit;
    if (args[0] === 'rev-parse' && args[1] === 'HEAD:LICENSE') return entry.license.blob;
    if (args[0] === 'status') return '';
    return git(cwd, args);
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
test('verifies cache paths are ignored and not tracked', (t) => {
  verifyRegistration(registeredRepository(t), entries);
});
test('fails closed when an exact ignore rule is missing', (t) => {
  const directory = registeredRepository(t);
  writeFileSync(resolve(directory, '.gitignore'), '/vendor/web-experience/photoswipe/\n');
  assert.throws(() => verifyRegistration(directory, entries), /Missing exact cache ignore rule/);
});
test('rejects a tracked gitlink even when cache is ignored', (t) => {
  const directory = registeredRepository(t);
  git(directory, ['update-index', '--add', '--cacheinfo', `160000,${entries[0].commit},${entries[0].path}`]);
  assert.throws(() => verifyRegistration(directory, entries), /Tracked source or gitlink/);
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
test('initialization clones selected SHA only, not floating HEAD', (t) => {
  const directory = registeredRepository(t);
  const log = [];
  initializeSources(directory, [entries[2]], simulatedClone(log, entries[2]));
  const clone = log.find((item) => item.args.includes('clone'))?.args;
  assert.ok(clone);
  assert.ok(clone.includes('--no-checkout') && clone.includes('--filter=blob:none'));
  assert.ok(!clone.includes('--remote') && !clone.includes('--force') && !clone.includes('--recursive'));
  assert.ok(log.some((item) => item.args.includes('checkout') && item.args.includes(entries[2].commit)));
  assert.equal(sourceState(directory, entries[2], simulatedClone([], entries[2])), 'verified');
  assert.equal(sourceState(directory, entries[0]), 'not-initialized');
});
test('preserves dirty checkouts instead of attempting clones', (t) => {
  const directory = registeredRepository(t);
  const log = [];
  assert.throws(() => initializeSources(directory, [entries[0]], simulatedClone(log, entries[0]), () => 'dirty'), /no automatic overwrite/);
  assert.ok(!log.some((item) => item.args.includes('clone')));
});
test('post-publication verification failure is never reported as success', (t) => {
  const directory = registeredRepository(t);
  let seen = 0;
  assert.throws(() => initializeSources(directory, [entries[0]], simulatedClone([], entries[0]), () =>
    ++seen === 1 ? 'not-initialized' : 'wrong-commit'), /Published source verification failed/);
});
test('rejects unmanaged folders in the cache instead of overwriting them', (t) => {
  const directory = registeredRepository(t);
  mkdirSync(resolve(directory, entries[0].path));
  assert.throws(() => sourceState(directory, entries[0]), /Unexpected source checkout/);
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
