#!/usr/bin/env node
/** Mandatory real Rust TFHE binary: positive tests never use a mock or skip. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {chmodSync,lstatSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runGaussNemesis} from '../bridge.mjs';

const binary=process.env.NEMESIS89_ROLES_BINARY;
const expectedBinarySha256=process.env.NEMESIS89_ROLES_SHA256;
if(!binary||! /^[a-f0-9]{64}$/.test(expectedBinarySha256??''))
  throw new Error('NEMESIS_89_REAL_ROLES_BINARY_AND_TRUSTED_PIN_REQUIRED');
const hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(hash(readFileSync(binary)),expectedBinarySha256,'the real Rust CLI must match the independently supplied CI pin');
const root=mkdtempSync(join(tmpdir(),'gauss-nemesis89-sealed-ci-'));
chmodSync(root,0o700);
function evaluate(server,ciphertext,output){
  const result=spawnSync(binary,['evaluate',server,ciphertext,output,'xor:0:1;mux:2:3:0;not:4','3,4,5'],
    {encoding:'utf8',timeout:240000,maxBuffer:1024*1024,shell:false});
  assert.equal(result.status,0,'real evaluator must calculate encrypted circuit');
  assert.equal(result.stdout,'','real evaluator must not return plaintext');
}
try{
  const vaultPath=join(root,'client.sealed'),serverPath=join(root,'server.key');
  const ciphertextPath=join(root,'input.ct'),outputPath=join(root,'output.ct');
  const common={binary,expectedBinarySha256,vaultPath,passphrase:'CI-ONLY-89-long-secret-never-use-in-production'};
  const created=await runGaussNemesis(89,{...common,action:'sealed-keygen',serverPath});
  assert.equal(created.vaultEncrypted,true);
  assert.equal(created.serverKeySha256,hash(readFileSync(serverPath)));
  assert.equal(lstatSync(vaultPath).mode&0o777,0o600);
  assert.equal(lstatSync(serverPath).mode&0o777,0o600);
  const stored=readFileSync(vaultPath,'utf8');
  assert.equal(JSON.parse(stored).algorithm,'AES-256-GCM-SCRYPT-N32768');
  assert.ok(!stored.includes(common.passphrase),'passphrase must not appear in the vault');
  const encrypted=await runGaussNemesis(89,{...common,action:'sealed-encrypt',
    serverKeySha256:created.serverKeySha256,ciphertextPath,bits:'101'});
  assert.equal(encrypted.ciphertextWritten,true);
  evaluate(serverPath,ciphertextPath,outputPath);
  assert.equal((await runGaussNemesis(89,{...common,action:'sealed-decrypt',
    serverKeySha256:created.serverKeySha256,outputPath})).bits,'110');
  await assert.rejects(()=>runGaussNemesis(89,{...common,action:'sealed-decrypt',
    serverKeySha256:created.serverKeySha256,passphrase:'wrong-CI-only-secret-not-production',outputPath}),/DECRYPT/);
  const newVaultPath=join(root,'new-client.sealed'),newPassphrase='another-CI-only-secret-that-is-long-enough';
  const rotated=await runGaussNemesis(89,{...common,action:'sealed-rekey',
    serverKeySha256:created.serverKeySha256,newVaultPath,newPassphrase});
  assert.equal(rotated.rotated,true);
  assert.notEqual(readFileSync(newVaultPath,'utf8'),stored,'new salt and IV required');
  assert.equal((await runGaussNemesis(89,{...common,action:'sealed-decrypt',
    vaultPath:newVaultPath,passphrase:newPassphrase,serverKeySha256:created.serverKeySha256,outputPath})).bits,'110');
  await assert.rejects(()=>runGaussNemesis(89,{...common,action:'sealed-rekey',
    serverKeySha256:created.serverKeySha256,newVaultPath,newPassphrase}),/PERSIST/);
  const link=join(root,'symlink.sealed');symlinkSync(vaultPath,link);
  await assert.rejects(()=>runGaussNemesis(89,{...common,action:'sealed-decrypt',
    vaultPath:link,serverKeySha256:created.serverKeySha256,outputPath}),/UNSAFE_FILE/);
  const changed=JSON.parse(stored);
  changed.ciphertext=(changed.ciphertext[0]==='A'?'B':'A')+changed.ciphertext.slice(1);
  writeFileSync(vaultPath,JSON.stringify(changed));
  await assert.rejects(()=>runGaussNemesis(89,{...common,action:'sealed-decrypt',
    serverKeySha256:created.serverKeySha256,outputPath}),/DECRYPT/);
  console.log(JSON.stringify({motor:89,backend:'REAL_TFHE_RUST',sealedVault:'AES-256-GCM-SCRYPT',
    encryptedCircuit:'PASS',rekey:'PASS',negativeCases:'PASS',scope:'LOCAL_LINUX_TMPFS_NOT_REMOTE_PRODUCTION_CERTIFICATION'}));
}finally{rmSync(root,{recursive:true,force:true});}
