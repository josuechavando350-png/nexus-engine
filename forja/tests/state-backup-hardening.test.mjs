import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSnapshot, verifySnapshot, restoreSnapshot } from '../state-backup.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'forja-hardening-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, {recursive:true, force:true}));
  const state=join(root,'state'), backup=join(root,'backup'), id=randomUUID();
  await mkdir(state,{mode:0o700}); await mkdir(backup,{mode:0o700});
  await mkdir(join(state,'jobs'),{mode:0o700});
  await mkdir(join(state,'artifacts'),{mode:0o700});
  await mkdir(join(state,'artifacts',id),{mode:0o700});
  await mkdir(join(state,'approval-redemptions'),{mode:0o700});
  await writeFile(join(state,'jobs',`${id}.json`),'{}\n',{mode:0o600});
  return {root,state,backup,id};
}

test('reject unexpected empty nested directories, including in authenticated snapshots', async t => {
  const f=await fixture(t);
  for (const prefix of ['jobs','approval-redemptions',`artifacts/${f.id}`]) {
    const unexpected=join(f.state,prefix,'unexpected-empty');
    await mkdir(unexpected,{mode:0o700});
    await assert.rejects(createSnapshot(f.state,f.backup),/unexpected or public directory/);
    await rm(unexpected,{recursive:true});
  }
  const saved=await createSnapshot(f.state,f.backup);
  const unexpected=join(f.backup,'snapshots',saved.id,'jobs','unexpected-empty');
  await mkdir(unexpected,{mode:0o700});
  await assert.rejects(verifySnapshot(f.backup,saved.id),/unexpected or public directory/);
  await assert.rejects(restoreSnapshot(f.backup,saved.id,join(f.root,'restored')),/unexpected or public directory/);
  await assert.rejects(lstat(join(f.root,'restored')),/ENOENT/);
});

test('signed restore cannot switch manifest between verification and recovery', async t => {
  const f=await fixture(t), saved=await createSnapshot(f.state,f.backup);
  await assert.rejects(restoreSnapshot(f.backup,saved.id,join(f.root,'wrong'),'0'.repeat(64)),/authenticated manifest changed/);
  await assert.rejects(lstat(join(f.root,'wrong')),/ENOENT/);
  const file=join(f.backup,'snapshots',saved.id,'manifest.json');
  const original=await readFile(file,'utf8');
  await writeFile(file,` ${original}`,{mode:0o600});
  assert.notEqual((await verifySnapshot(f.backup,saved.id)).manifestSha256,saved.manifestSha256);
  await assert.rejects(restoreSnapshot(f.backup,saved.id,join(f.root,'changed'),saved.manifestSha256),/authenticated manifest changed/);
  await assert.rejects(lstat(join(f.root,'changed')),/ENOENT/);
});
