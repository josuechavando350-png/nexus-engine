import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSnapshot } from '../state-backup.mjs';
import { signSnapshot, verifySignedSnapshot, restoreSignedSnapshot } from '../signed-backup.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'forja-signed-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, {recursive:true, force:true}));
  const state = join(root,'state'), backup = join(root,'backup'), receipts = join(root,'receipts'), keys = join(root,'keys');
  for (const path of [state,backup,receipts,keys]) await mkdir(path, {mode:0o700});
  const jobId='11111111-2222-4333-8444-555555555555';
  await mkdir(join(state, 'jobs'), {mode:0o700});
  await writeFile(join(state,'jobs',`${jobId}.json`),JSON.stringify({id:jobId,sourceRevision:'a'.repeat(40),status:'SUCCEEDED'})+'\n',{mode:0o600});
  const saved=await createSnapshot(state,backup);
  const pair=generateKeyPairSync('ed25519');
  const privateKeyPath=join(keys,'private.pem'), publicKeyPath=join(keys,'public.pem');
  await writeFile(privateKeyPath,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  await writeFile(publicKeyPath,pair.publicKey.export({type:'spki',format:'pem'}),{mode:0o644});
  const pin=digest(pair.publicKey.export({type:'spki',format:'der'}));
  return {root,state,backup,receipts,keys,privateKeyPath,publicKeyPath,pin,pair,saved};
}

test('signed round-trip verifies pinned Ed25519 key and restores byte-identical offline state', async(t)=>{
  const f=await fixture(t);
  const r=await signSnapshot(f.backup,f.saved.id,f.privateKeyPath,f.receipts);
  assert.equal(r.signerKeySha256,f.pin);
  const v=await verifySignedSnapshot(f.backup,f.saved.id,f.receipts,f.publicKeyPath,f.pin);
  assert.equal(v.status,'SIGNED_SNAPSHOT_VERIFIED');
  assert.equal(v.manifestSha256,f.saved.manifestSha256);
  const target=join(f.root,'recovered');
  const restored=await restoreSignedSnapshot(f.backup,f.saved.id,f.receipts,f.publicKeyPath,f.pin,target);
  assert.equal(restored.status,'SIGNED_SNAPSHOT_RESTORED_QUARANTINED');
  const job='11111111-2222-4333-8444-555555555555.json';
  assert.deepEqual(await readFile(join(target,'jobs',job)), await readFile(join(f.state,'jobs',job)));
  await assert.rejects(restoreSignedSnapshot(f.backup,f.saved.id,f.receipts,f.publicKeyPath,f.pin,target),/already exists/);
  await assert.rejects(signSnapshot(f.backup,f.saved.id,f.privateKeyPath,f.receipts),/EEXIST/);
});

test('tampered snapshot bytes and rehashed forged manifest both fail signed verification',async(t)=>{
  const f=await fixture(t);await signSnapshot(f.backup,f.saved.id,f.privateKeyPath,f.receipts);
  const job=join(f.backup,'snapshots',f.saved.id,'jobs','11111111-2222-4333-8444-555555555555.json');
  await writeFile(job,'{"forged":true}\n',{mode:0o600});
  await assert.rejects(verifySignedSnapshot(f.backup,f.saved.id,f.receipts,f.publicKeyPath,f.pin),/snapshot bytes mismatch/);
  const manifestPath=join(f.backup,'snapshots',f.saved.id,'manifest.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  const contents=await readFile(job);
  manifest.files[0].sha256=digest(contents);manifest.files[0].size=contents.length;
  await writeFile(manifestPath,JSON.stringify(manifest)+'\n',{mode:0o600});
  await assert.rejects(verifySignedSnapshot(f.backup,f.saved.id,f.receipts,f.publicKeyPath,f.pin),/signed manifest does not match/);
  const target=join(f.root,'forged');
  await assert.rejects(restoreSignedSnapshot(f.backup,f.saved.id,f.receipts,f.publicKeyPath,f.pin,target),/signed manifest does not match/);
  await assert.rejects(lstat(target),/ENOENT/);
});

test('forged signatures, changed receipt fields and replaced keys are rejected',async(t)=>{
  const f=await fixture(t);await signSnapshot(f.backup,f.saved.id,f.privateKeyPath,f.receipts);
  const receiptPath=join(f.receipts,`${f.saved.id}.json`);
  const original=JSON.parse(await readFile(receiptPath,'utf8'));
  for (const mutation of [
    {...original,signature:Buffer.alloc(64).toString('base64')},
    {...original,signature:'oops'},
    {...original,snapshotId:'11111111-2222-4333-8444-555555555555'},
    {...original,unexpected:'injection'},
  ]) {
    await writeFile(receiptPath,JSON.stringify(mutation)+'\n',{mode:0o600});
    await assert.rejects(verifySignedSnapshot(f.backup,f.saved.id,f.receipts,f.publicKeyPath,f.pin),/signed receipt|signature/);
  }
  await writeFile(receiptPath,JSON.stringify(original)+'\n',{mode:0o600});
  await assert.rejects(verifySignedSnapshot(f.backup,f.saved.id,f.receipts,f.publicKeyPath,'0'.repeat(64)),/untrusted public key/);
  const imposter=generateKeyPairSync('ed25519');
  const rogue=join(f.keys,'rogue.pem');
  await writeFile(rogue,imposter.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
  await assert.rejects(verifySignedSnapshot(f.backup,f.saved.id,f.receipts,rogue,f.pin),/untrusted public key/);
});

test('signing key must be private and outside backup and receipts; symlink and RSA rejected',async(t)=>{
  const f=await fixture(t);
  await chmod(f.privateKeyPath,0o644);
  await assert.rejects(signSnapshot(f.backup,f.saved.id,f.privateKeyPath,f.receipts),/unsafe key file/);
  await chmod(f.privateKeyPath,0o600);
  const link=join(f.keys,'link.pem');
  await symlink(f.privateKeyPath,link);
  await assert.rejects(signSnapshot(f.backup,f.saved.id,link,f.receipts),/ELOOP|symbolic link/);
  const unsafe=join(f.backup,'leaked.pem');
  await writeFile(unsafe,await readFile(f.privateKeyPath),{mode:0o600});
  await assert.rejects(signSnapshot(f.backup,f.saved.id,unsafe,f.receipts),/outside backup and receipts/);
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
  await writeFile(f.privateKeyPath,rsa.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  await assert.rejects(signSnapshot(f.backup,f.saved.id,f.privateKeyPath,f.receipts),/Ed25519/);
});

test('a valid receipt for one snapshot cannot authenticate a different snapshot', async(t)=>{
  const f=await fixture(t); const receipt=await signSnapshot(f.backup,f.saved.id,f.privateKeyPath,f.receipts);
  const second=await createSnapshot(f.state,f.backup);
  await writeFile(join(f.receipts,`${second.id}.json`), JSON.stringify({...receipt,snapshotId:second.id})+'\n',{mode:0o600});
  await assert.rejects(verifySignedSnapshot(f.backup,second.id,f.receipts,f.publicKeyPath,f.pin),/signature mismatch/);
});
