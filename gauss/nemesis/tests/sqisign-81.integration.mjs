/** REAL upstream SQIsign p324_3 keygen/sign/verify, required by dedicated CI; never skipped. */
import test from 'node:test';
import assert from 'node:assert/strict';
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
