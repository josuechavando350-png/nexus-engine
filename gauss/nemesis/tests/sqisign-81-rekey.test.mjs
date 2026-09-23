import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash,scryptSync,createCipheriv,createDecipheriv} from 'node:crypto';
import {chmodSync,mkdtempSync,rmSync,writeFileSync,readFileSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runGaussNemesis} from '../bridge.mjs';

const idOf=pub=>createHash('sha256').update(Buffer.concat([Buffer.from('NEMESIS81-PUBLIC-KEY-V1\0'),pub])).digest('hex');
const aad=(pub,id)=>Buffer.from(`NEMESIS81-SEALED-V1:${id}:${pub.toString('base64')}`);
function sealTestKey(pub,id,secret,pass){
  // Synthetic key bytes test only the REAL AES-256-GCM/scrypt storage path.
  // A separate mandatory CI test signs using the genuine upstream SQIsign engine.
  const salt=randomBytes(16),iv=randomBytes(12),key=scryptSync(pass,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  try{
    const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(pub,id));
    const ct=Buffer.concat([cipher.update(secret),cipher.final()]);
    return {version:1,algorithm:'AES-256-GCM-SCRYPT-N32768',keyId:id,publicKeyBase64:pub.toString('base64'),
      salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ct.toString('base64')};
  }finally{key.fill(0);salt.fill(0);iv.fill(0);}
}

test('81: rotate encrypted private key without overwrite, private-key response or loss on failure',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'nemesis81-rekey-unit-'));chmodSync(dir,0o700);
  try{
    const old=join(dir,'old.enc'),next=join(dir,'next.enc');
    const pub=randomBytes(83),secret=randomBytes(270),id=idOf(pub);
    const oldPass='CI-only old passphrase distinct from the new one';
    const newPass='CI-only new passphrase distinct from the old one';
    const before=sealTestKey(pub,id,secret,oldPass);
    writeFileSync(old,JSON.stringify(before),{mode:0o600});
    const request={action:'sqisign-rekey-sealed',keyPath:old,newKeyPath:next,
      passphrase:oldPass,newPassphrase:newPass,expectedKeyId:id};
    const result=await runGaussNemesis(81,request);
    assert.equal(result.rotated,true);assert.equal(result.keyId,id);
    assert.equal(Object.hasOwn(result,'secretKeyBase64'),false);
    assert.equal(statSync(next).mode&0o777,0o600);
    assert.deepEqual(JSON.parse(readFileSync(old,'utf8')),before);
    const rotated=JSON.parse(readFileSync(next,'utf8'));
    assert.notEqual(rotated.salt,before.salt);assert.notEqual(rotated.iv,before.iv);
    const derived=scryptSync(newPass,Buffer.from(rotated.salt,'base64'),32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
    try{
      const decipher=createDecipheriv('aes-256-gcm',derived,Buffer.from(rotated.iv,'base64'));
      decipher.setAAD(aad(pub,id));decipher.setAuthTag(Buffer.from(rotated.tag,'base64'));
      assert.deepEqual(Buffer.concat([decipher.update(Buffer.from(rotated.ciphertext,'base64')),decipher.final()]),secret);
    }finally{derived.fill(0);}
    const rejected=join(dir,'wrong.enc');
    await assert.rejects(()=>runGaussNemesis(81,{...request,newKeyPath:rejected,
      passphrase:'wrong old passphrase of sufficient length'}),/DECRYPT_FAILED/);
    assert.equal(existsSync(rejected),false);
    await assert.rejects(()=>runGaussNemesis(81,request),/FILE_EXISTS/);
    await assert.rejects(()=>runGaussNemesis(81,{...request,newKeyPath:old}),/NEW_KEY_PATH_REQUIRED/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
