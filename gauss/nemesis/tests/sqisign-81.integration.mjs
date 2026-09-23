/** REAL upstream SQIsign p324_3 keygen/sign/verify, required by dedicated CI; never skipped. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runGaussNemesis} from '../bridge.mjs';

const binary=process.env.NEMESIS81_BINARY;
const expectedBinarySha256=process.env.NEMESIS81_SHA256;
if (!binary || !/^[a-f0-9]{64}$/.test(expectedBinarySha256??''))
  throw new Error('NEMESIS_81_REAL_BINARY_AND_PIN_REQUIRED: no mock or skipped positive tests');
const native={binary,expectedBinarySha256};
const b64=message=>Buffer.from(message).toString('base64');

test('81: real SQIsign p324_3 generates keys, signs, verifies and rejects tampering',async()=>{
  const keys=await runGaussNemesis(81,{action:'sqisign-keygen',...native});
  const keys2=await runGaussNemesis(81,{action:'sqisign-keygen',...native});
  assert.equal(keys.domain,'SQISIGN_P324_3_NATIVE');
  assert.equal(Buffer.from(keys.publicKeyBase64,'base64').length,83);
  assert.equal(Buffer.from(keys.secretKeyBase64,'base64').length,270);
  assert.notEqual(keys.publicKeyBase64,keys2.publicKeyBase64,'fresh key pairs must differ');
  const m=b64('GAUSS Némesis #81 genuine SQIsign signature');
  const signed=await runGaussNemesis(81,{action:'sqisign-sign',secretKeyBase64:keys.secretKeyBase64,messageBase64:m,...native});
  assert.equal(Buffer.from(signed.signatureBase64,'base64').length,200);
  const req={action:'sqisign-verify',publicKeyBase64:keys.publicKeyBase64,
    signatureBase64:signed.signatureBase64,messageBase64:m,...native};
  assert.equal((await runGaussNemesis(81,req)).verified,true);
  assert.equal((await runGaussNemesis(81,{...req,messageBase64:b64('altered message')})).verified,false);
  assert.equal((await runGaussNemesis(81,{...req,publicKeyBase64:keys2.publicKeyBase64})).verified,false);
  const changed=Buffer.from(signed.signatureBase64,'base64');changed[0]^=1;
  assert.equal((await runGaussNemesis(81,{...req,signatureBase64:changed.toString('base64')})).verified,false);
  assert.equal((await runGaussNemesis(81,{...req,messageBase64:b64('GAUSS Némesis #81 genuine SQIsign signature')})).verified,true);
});

test('81: real sealed key never returns the private key and refuses tampering, wrong passphrase and unsafe files',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'nemesis81-real-vault-'));
  chmodSync(dir,0o700);
  try{
    const keyPath=join(dir,'secret.enc');
    const common={...native,keyPath,passphrase:'CI-ONLY-not-a-production-passphrase-64-char-test-vector'};
    const created=await runGaussNemesis(81,{action:'sqisign-keygen-sealed',...common});
    assert.equal(created.domain,'SQISIGN_P324_3_SEALED_LOCAL');
    assert.equal(Object.hasOwn(created,'secretKeyBase64'),false);
    assert.match(created.keyId,/^[a-f0-9]{64}$/);
    assert.equal(lstatSync(keyPath).mode&0o777,0o600);
    const sealed=readFileSync(keyPath,'utf8');
    assert.ok(!sealed.includes(common.passphrase));
    const messageBase64=b64('Némesis #81 sealed custody real signature');
    const signed=await runGaussNemesis(81,{action:'sqisign-sign-sealed',...common,messageBase64,expectedKeyId:created.keyId});
    assert.equal(Object.hasOwn(signed,'secretKeyBase64'),false);
    assert.equal(signed.keyId,created.keyId);
    assert.equal((await runGaussNemesis(81,{action:'sqisign-verify',...native,
      publicKeyBase64:created.publicKeyBase64,signatureBase64:signed.signatureBase64,messageBase64})).verified,true);
    await assert.rejects(()=>runGaussNemesis(81,{action:'sqisign-sign-sealed',...common,
      passphrase:'wrong-CI-only-passphrase-not-real',messageBase64,expectedKeyId:created.keyId}),/DECRYPT_FAILED/);
    await assert.rejects(()=>runGaussNemesis(81,{action:'sqisign-sign-sealed',...common,
      messageBase64,expectedKeyId:'0'.repeat(64)}),/KEY_ID_MISMATCH/);
    const record=JSON.parse(sealed);
    record.ciphertext=record.ciphertext[0]==='A'?'B'+record.ciphertext.slice(1):'A'+record.ciphertext.slice(1);
    writeFileSync(keyPath,JSON.stringify(record));
    await assert.rejects(()=>runGaussNemesis(81,{action:'sqisign-sign-sealed',...common,
      messageBase64,expectedKeyId:created.keyId}),/DECRYPT_FAILED/);
    chmodSync(keyPath,0o644);
    await assert.rejects(()=>runGaussNemesis(81,{action:'sqisign-sign-sealed',...common,
      messageBase64,expectedKeyId:created.keyId}),/UNSAFE_FILE/);
    chmodSync(keyPath,0o600);
    const link=join(dir,'redirect.enc');symlinkSync(keyPath,link);
    await assert.rejects(()=>runGaussNemesis(81,{action:'sqisign-sign-sealed',...common,keyPath:link,
      messageBase64,expectedKeyId:created.keyId}),/UNSAFE_FILE/);
    await assert.rejects(()=>runGaussNemesis(81,{action:'sqisign-keygen-sealed',...common}),/FILE_EXISTS/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
