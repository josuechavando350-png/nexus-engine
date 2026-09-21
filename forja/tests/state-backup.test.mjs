import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSnapshot, verifySnapshot, restoreSnapshot } from '../state-backup.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'forja-backup-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, {recursive:true, force:true}));
  const state = join(root,'state'), backup = join(root,'backups');
  await mkdir(state, {mode:0o700}); await mkdir(backup, {mode:0o700});
  const id = randomUUID();
  await mkdir(join(state,'jobs'), {mode:0o700});
  await mkdir(join(state,'artifacts'), {mode:0o700});
  await mkdir(join(state,'artifacts',id), {mode:0o700});
  await mkdir(join(state,'approval-redemptions'), {mode:0o700});
  const payloads = {
    [`jobs/${id}.json`]: JSON.stringify({id,sourceRevision:'a'.repeat(40),status:'SUCCEEDED'})+'\n',
    [`artifacts/${id}/inventory.json`]: '{"result":"PASS"}\n',
    [`approval-redemptions/${randomUUID()}.json`]: '{"status":"CONSUMED_FOR_MANUAL_REVIEW_ONLY"}\n'
  };
  for (const [path, data] of Object.entries(payloads)) await writeFile(join(state,path),data,{mode:0o600});
  return {root,state,backup,payloads};
}
test('round-trip preserves byte identity and refuses overwriting a restore target', async(t) => {
  const f=await fixture(t); const saved=await createSnapshot(f.state,f.backup);
  assert.equal(saved.count,3);
  assert.deepEqual(await verifySnapshot(f.backup,saved.id),saved);
  const target=join(f.root,'restored');
  const restored=await restoreSnapshot(f.backup,saved.id,target);
  assert.equal(restored.restoredFiles,3);
  for (const [path,data] of Object.entries(f.payloads)) {
    assert.equal(await readFile(join(target,path),'utf8'),data);
    assert.equal((await lstat(join(target,path))).mode & 0o777,0o600);
  }
  await assert.rejects(restoreSnapshot(f.backup,saved.id,target),/already exists/);
});
test('changed, missing or unexpected backed-up bytes fail closed before restore',async(t)=>{
  const f=await fixture(t);const {id}=await createSnapshot(f.state,f.backup);
  const file=join(f.backup,'snapshots',id,Object.keys(f.payloads)[0]);
  await writeFile(file,'tampered',{mode:0o600});
  await assert.rejects(verifySnapshot(f.backup,id),/mismatch/);
  const target=join(f.root,'restored');
  await assert.rejects(restoreSnapshot(f.backup,id,target),/mismatch/);
  await assert.rejects(lstat(target),/ENOENT/);
});
test('active worker lock, unregistered file and symlink prevent backup',async(t)=>{
  const f=await fixture(t);await mkdir(join(f.state,'worker.lock'),{mode:0o700});
  await assert.rejects(createSnapshot(f.state,f.backup),/lock/);
  await rm(join(f.state,'worker.lock'),{recursive:true});
  await writeFile(join(f.state,'rogue.txt'),'secret',{mode:0o600});
  await assert.rejects(createSnapshot(f.state,f.backup),/unexpected/);
  await rm(join(f.state,'rogue.txt'));
  await symlink(join(f.state,Object.keys(f.payloads)[0]),join(f.state,'jobs',`${randomUUID()}.json`));
  await assert.rejects(createSnapshot(f.state,f.backup),/symlink/);
});
test('reject public storage, nested destination and snapshot path traversal',async(t)=>{
  const f=await fixture(t);await chmod(f.backup,0o755);
  await assert.rejects(createSnapshot(f.state,f.backup),/private/);
  await chmod(f.backup,0o700);
  await assert.rejects(createSnapshot(f.state,join(f.state,'artifacts')),/disjoint|private/);
  const {id}=await createSnapshot(f.state,f.backup);
  await assert.rejects(verifySnapshot(f.backup,'../x'),/invalid snapshot id/);
  await assert.rejects(restoreSnapshot(f.backup,id,join(f.backup,'restored')),/overlaps backup/);
});
test('reject corrupted manifest and partial snapshot without publishing output',async(t)=>{
  const f=await fixture(t);const {id}=await createSnapshot(f.state,f.backup);
  const snap=join(f.backup,'snapshots',id);
  const extra=join(snap,'jobs',`${randomUUID()}.json`);
  await writeFile(extra,'{}',{mode:0o600});
  await assert.rejects(verifySnapshot(f.backup,id),/file set mismatch/);
  await rm(extra);
  const manifest=join(snap,'manifest.json');
  const parsed=JSON.parse(await readFile(manifest,'utf8'));
  parsed.files[0].path='../escape';
  await writeFile(manifest,JSON.stringify(parsed),{mode:0o600});
  await assert.rejects(restoreSnapshot(f.backup,id,join(f.root,'restored')),/file set mismatch|invalid manifest entry/);
  assert.deepEqual((await readdir(f.root)).sort(),['backups','state']);
});
