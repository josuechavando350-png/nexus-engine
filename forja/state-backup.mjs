#!/usr/bin/env node
// Offline, single-host integrity snapshots. This does not stop a live submitter.
import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}';
const PATH = new RegExp(`^(?:jobs/${ID}\\.json|artifacts/${ID}/(?:inventory|audit|contract|consistency)\\.json|approval-redemptions/${ID}\\.json)$`);
const UUID = new RegExp(`^${ID}$`);
const MAX_FILES = 10000, MAX_FILE = 2 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024;
const digest = (data) => createHash('sha256').update(data).digest('hex');
function demand(value, reason) { if (!value) throw new Error(`FORJA_BACKUP: ${reason}`); }
function outside(a, b) { const rel = relative(a, b); return rel === '..' || rel.startsWith(`..${sep}`); }
async function privateDir(path, { create = false } = {}) {
  demand(typeof path === 'string' && isAbsolute(path), 'absolute directory required');
  if (create) await mkdir(path, { mode: 0o700 });
  const s = await lstat(path);
  demand(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o077) === 0 &&
    (typeof process.getuid !== 'function' || s.uid === process.getuid()), 'directory must be private and owned');
  return realpath(path);
}
async function syncDir(path) { const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await fd.sync(); } finally { await fd.close(); } }
async function bytes(path) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await fd.stat();
    demand(s.isFile() && s.nlink === 1 && s.size > 0 && s.size <= MAX_FILE && (s.mode & 0o077) === 0, 'unsafe file');
    const data = await fd.readFile();
    demand(data.length === s.size, 'file changed during read');
    return data;
  } finally { await fd.close(); }
}
async function paths(root, { manifest = false } = {}) {
  const result = [];
  async function walk(dir, prefix = '') {
    const children = (await readdir(dir)).sort();
    // Empty UUID artifact directories are valid paths but cannot be represented by
    // a file-only snapshot manifest. Refuse them rather than silently losing state.
    if (prefix.startsWith('artifacts/') && UUID.test(prefix.slice('artifacts/'.length))) {
      demand(children.length > 0, 'empty artifact directory');
    }
    for (const name of children) {
      demand(name !== 'worker.lock' && name !== 'backup.lock', 'active or stale lock; stop and inspect worker');
      const rel = prefix ? `${prefix}/${name}` : name;
      if (manifest && rel === 'manifest.json') continue;
      const s = await lstat(join(dir, name));
      demand(!s.isSymbolicLink(), 'symlink in state');
      if (s.isDirectory()) {
        demand((s.mode & 0o077) === 0 &&
          (prefix === '' ? ['jobs','artifacts','approval-redemptions'].includes(name) :
            prefix === 'artifacts' && UUID.test(name)), 'unexpected or public directory');
        await walk(join(dir, name), rel);
      } else {
        demand(s.isFile() && PATH.test(rel), `unexpected state file: ${rel}`);
        result.push(rel);
        demand(result.length <= MAX_FILES, 'too many files');
      }
    }
  }
  await walk(root);
  return result.sort();
}
async function writeSynced(path, data) {
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(data); await fd.sync(); } finally { await fd.close(); }
}
async function populate(base, records) {
  for (const { path, data } of records) {
    const components = path.split('/'); let dir = base;
    for (const part of components.slice(0, -1)) {
      dir = join(dir, part);
      try { await mkdir(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    await writeSynced(join(base, ...components), data);
  }
  const dirs = ['jobs','artifacts','approval-redemptions', ...records.map(({path}) => path.startsWith('artifacts/') ? path.split('/').slice(0,2).join('/') : '')]
    .filter(Boolean).filter((x, i, all) => all.indexOf(x) === i).sort((a,b) => b.length-a.length);
  for (const dir of dirs) {
    try { await syncDir(join(base, dir)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await syncDir(base);
}
async function readSnapshot(snapshot) {
  await privateDir(snapshot);
  const manifestBytes = await bytes(join(snapshot, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  demand(manifest.schemaVersion === 1 && UUID.test(manifest.id) && basename(snapshot) === manifest.id &&
    Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= MAX_FILES, 'invalid manifest');
  const listed = await paths(snapshot, { manifest: true });
  demand(listed.join('\n') === manifest.files.map((item) => item.path).join('\n'), 'snapshot file set mismatch');
  const records = []; let total = 0, prev = '';
  for (const item of manifest.files) {
    demand(item && typeof item.path === 'string' && PATH.test(item.path) && item.path > prev &&
      Number.isSafeInteger(item.size) && item.size > 0 && item.size <= MAX_FILE && /^[a-f0-9]{64}$/.test(item.sha256), 'invalid manifest entry');
    prev = item.path;
    const data = await bytes(join(snapshot, item.path)); total += data.length;
    demand(total <= MAX_TOTAL && data.length === item.size && digest(data) === item.sha256, 'snapshot bytes mismatch');
    records.push({ path: item.path, data });
  }
  return { manifest, manifestSha256: digest(manifestBytes), records };
}
export async function createSnapshot(stateDir, backupRoot) {
  const state = await privateDir(stateDir), backup = await privateDir(backupRoot);
  demand(outside(state, backup) && outside(backup, state), 'state and backup must be disjoint');
  const names = await paths(state);
  demand(names.length > 0, 'empty state');
  const records = []; let total = 0;
  for (const path of names) {
    const data = await bytes(join(state, path)); total += data.length;
    demand(total <= MAX_TOTAL, 'state too large');
    records.push({ path, data });
  }
  const snapshots = join(backup, 'snapshots');
  try { await mkdir(snapshots, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  await privateDir(snapshots);
  const id = randomUUID(), stage = join(snapshots, `.partial-${id}`), published = join(snapshots, id);
  await mkdir(stage, { mode: 0o700 });
  try {
    await populate(stage, records);
    const manifest = { schemaVersion: 1, id, files: records.map(({path,data}) => ({path, size:data.length, sha256:digest(data)})) };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await writeSynced(join(stage, 'manifest.json'), manifestBytes);
    await syncDir(stage);
    demand((await paths(state)).join('\n') === names.join('\n'), 'source file set changed');
    for (const {path,data} of records) demand(digest(await bytes(join(state, path))) === digest(data), 'source changed during snapshot');
    await rename(stage, published); await syncDir(snapshots);
    return { id, count: records.length, bytes: total, manifestSha256: digest(manifestBytes) };
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}
export async function verifySnapshot(backupRoot, id) {
  const backup = await privateDir(backupRoot);
  demand(UUID.test(id), 'invalid snapshot id');
  const { manifestSha256, records } = await readSnapshot(join(backup, 'snapshots', id));
  return { id, count: records.length, bytes: records.reduce((sum, x) => sum+x.data.length, 0),
    manifestSha256 };
}
export async function restoreSnapshot(backupRoot, id, targetDir, expectedManifestSha256 = null) {
  const backup = await privateDir(backupRoot);
  demand(UUID.test(id) && typeof targetDir === 'string' && isAbsolute(targetDir), 'invalid restore inputs');
  const requested = resolve(targetDir), parent = await privateDir(dirname(requested));
  const target = join(parent, basename(requested));
  demand(outside(backup, target) && outside(target, backup), 'restore destination overlaps backup');
  await lstat(target).then(() => demand(false, 'restore target already exists'), (e) => { if (e.code !== 'ENOENT') throw e; });
  const { manifestSha256, records } = await readSnapshot(join(backup, 'snapshots', id));
  if (expectedManifestSha256 !== null) {
    demand(typeof expectedManifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(expectedManifestSha256) &&
      manifestSha256 === expectedManifestSha256, 'authenticated manifest changed before restore');
  }
  const stage = join(parent, `.forja-restore-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    await populate(stage, records);
    for (const {path,data} of records) demand(digest(await bytes(join(stage,path))) === digest(data), 'restore write mismatch');
    await rename(stage, target); await syncDir(parent);
    return { id, target, restoredFiles: records.length };
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    demand((command === 'create' && args.length === 2) || (command === 'verify' && args.length === 2) ||
      (command === 'restore' && args.length === 3), 'usage: create stateDir backupRoot | verify backupRoot id | restore backupRoot id absentTarget');
    const result = command === 'create' ? await createSnapshot(...args) : command === 'verify' ? await verifySnapshot(...args) : await restoreSnapshot(...args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { console.error(String(error.message ?? error)); process.exitCode = 1; }
}
