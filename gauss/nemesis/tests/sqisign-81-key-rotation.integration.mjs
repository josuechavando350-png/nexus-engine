import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runGaussNemesis} from '../bridge.mjs';

const binary=process.env.NEMESIS81_BINARY;
const expectedBinarySha256=process.env.NEMESIS81_SHA256;
if(!binary||!/^[a-f0-9]{64}$/.test(expectedBinarySha256??''))
  throw new Error('REAL_SQISIGN_81_BINARY_AND_TRUSTED_PIN_REQUIRED');
const common={binary,expectedBinarySha256};

test('81: rotate the actual SQIsign key pair; verify both signatures against externally pinned old key',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'nemesis81-keypair-rotation-real-'));
  chmodSync(dir,0o700);
  try{
    const oldKeyPath=join(dir,'old.enc'),newKeyPath=join(dir,'new.enc');
    const oldPassphrase='CI-only old password for real SQIsign rotation';
    const newPassphrase='CI-only new password for real SQIsign rotation';
    const old=await runGaussNemesis(81,{action:'sqisign-keygen-sealed',...common,
      keyPath:oldKeyPath,passphrase:oldPassphrase});
    const oldVault=readFileSync(oldKeyPath);
    const rotated=await runGaussNemesis(81,{action:'sqisign-rotate-keypair-sealed',...common,
      oldKeyPath,oldPassphrase,oldPublicKeyBase64:old.publicKeyBase64,
      expectedOldKeyId:old.keyId,newKeyPath,newPassphrase});
    assert.equal(rotated.rotated,true);
    assert.notEqual(rotated.newKeyId,old.keyId,'rotation must change the actual public key');
    assert.equal(rotated.certificate.oldKeyId,old.keyId);
    assert.equal(rotated.certificate.newKeyId,rotated.newKeyId);
    assert.equal(readFileSync(oldKeyPath).equals(oldVault),true,'old encrypted key remains intact');
    assert.equal(existsSync(newKeyPath),true,'new encrypted key must exist');
    assert.equal(Object.hasOwn(rotated,'secretKeyBase64'),false);
    const verified=await runGaussNemesis(81,{action:'sqisign-verify-key-rotation',...common,
      certificate:rotated.certificate,expectedOldKeyId:old.keyId});
    assert.equal(verified.verified,true,'new trust anchor requires both real SQIsign signatures');
    assert.equal((await runGaussNemesis(81,{action:'sqisign-verify-key-rotation',...common,
      certificate:rotated.certificate,expectedOldKeyId:'0'.repeat(64)})).verified,false,
      'attacker-provided old public key must not establish trust');
    const changed={...rotated.certificate,newKeyId:'0'.repeat(64)};
    assert.equal((await runGaussNemesis(81,{action:'sqisign-verify-key-rotation',...common,
      certificate:changed,expectedOldKeyId:old.keyId})).verified,false);
    const signature=Buffer.from(rotated.certificate.newSignatureBase64,'base64');signature[0]^=1;
    assert.equal((await runGaussNemesis(81,{action:'sqisign-verify-key-rotation',...common,
      certificate:{...rotated.certificate,newSignatureBase64:signature.toString('base64')},
      expectedOldKeyId:old.keyId})).verified,false,'tampered new-key signature must fail');
    const messageBase64=Buffer.from('new SQIsign key signs after rotation').toString('base64');
    const signed=await runGaussNemesis(81,{action:'sqisign-sign-sealed',...common,
      keyPath:newKeyPath,passphrase:newPassphrase,expectedKeyId:rotated.newKeyId,messageBase64});
    assert.equal((await runGaussNemesis(81,{action:'sqisign-verify',...common,
      publicKeyBase64:rotated.certificate.newPublicKeyBase64,
      signatureBase64:signed.signatureBase64,messageBase64})).verified,true);
    await assert.rejects(()=>runGaussNemesis(81,{action:'sqisign-rotate-keypair-sealed',...common,
      oldKeyPath,oldPassphrase,oldPublicKeyBase64:old.publicKeyBase64,
      expectedOldKeyId:old.keyId,newKeyPath,newPassphrase}),/FILE_EXISTS/);
    assert.equal(readFileSync(oldKeyPath).equals(oldVault),true);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
