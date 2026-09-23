/** GAUSS/Némesis #81: actual SQIsign key-pair rotation, not merely a password rewrap.
 * An independently trusted old public key ID is REQUIRED. A transition
 * certificate proves possession of both private keys; an operator must still
 * distribute/approve the new trust anchor through an authenticated channel.
 */
import {createHash} from 'node:crypto';
import {runGaussNemesis81Sealed} from './sqisign-81-sealed.mjs';
import {runGaussNemesis81Signature} from './native-sqisign-81.mjs';

const HEX=/^[a-f0-9]{64}$/;
const fail=code=>{throw new Error(`NEMESIS_81_ROTATION_${code}`);};
function fields(value,allowed,required=allowed){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)
    fail('INPUT');
  if(Object.keys(value).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(value,k)))
    fail('FIELDS');
}
function publicKey(value){
  if(typeof value!=='string'||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    fail('PUBLIC_KEY');
  const bytes=Buffer.from(value,'base64');
  try{
    if(bytes.length!==83||bytes.toString('base64')!==value)fail('PUBLIC_KEY');
    return createHash('sha256').update('NEMESIS81-PUBLIC-KEY-V1\0').update(bytes).digest('hex');
  }finally{bytes.fill(0);}
}
function statement(oldId,newId,newPublic){
  return Buffer.from(`GAUSS-NEMESIS81-KEYPAIR-ROTATION-V1\0${oldId}\0${newId}\0${newPublic}`,'utf8').toString('base64');
}
function authenticateOld(common,oldKeyPath,oldPassphrase,expectedOldKeyId,oldPublicKeyBase64){
  const auth=Buffer.from(`GAUSS-NEMESIS81-ROTATION-OLD-KEY-CHECK-V1\0${expectedOldKeyId}`,'utf8').toString('base64');
  const signed=runGaussNemesis81Sealed({action:'sqisign-sign-sealed',...common,
    keyPath:oldKeyPath,passphrase:oldPassphrase,expectedKeyId:expectedOldKeyId,messageBase64:auth});
  if(signed.publicKeyBase64!==oldPublicKeyBase64)fail('OLD_PUBLIC_KEY_MISMATCH');
  const proof=runGaussNemesis81Signature({action:'sqisign-verify',...common,
    publicKeyBase64:oldPublicKeyBase64,signatureBase64:signed.signatureBase64,messageBase64:auth});
  if(!proof.verified)fail('OLD_KEY_PROOF_FAILED');
}
function verifyCertificate(certificate,expectedOldKeyId,common){
  fields(certificate,['version','domain','oldKeyId','oldPublicKeyBase64','newKeyId',
    'newPublicKeyBase64','oldSignatureBase64','newSignatureBase64']);
  if(certificate.version!==1||certificate.domain!=='GAUSS_NEMESIS81_KEYPAIR_ROTATION_V1'||
     !HEX.test(expectedOldKeyId)||certificate.oldKeyId!==expectedOldKeyId||
     !HEX.test(certificate.newKeyId))return false;
  if(publicKey(certificate.oldPublicKeyBase64)!==expectedOldKeyId||
     publicKey(certificate.newPublicKeyBase64)!==certificate.newKeyId||
     certificate.newKeyId===expectedOldKeyId)return false;
  const messageBase64=statement(expectedOldKeyId,certificate.newKeyId,certificate.newPublicKeyBase64);
  const old=runGaussNemesis81Signature({action:'sqisign-verify',...common,
    publicKeyBase64:certificate.oldPublicKeyBase64,signatureBase64:certificate.oldSignatureBase64,messageBase64});
  if(!old.verified)return false;
  const newer=runGaussNemesis81Signature({action:'sqisign-verify',...common,
    publicKeyBase64:certificate.newPublicKeyBase64,signatureBase64:certificate.newSignatureBase64,messageBase64});
  return newer.verified;
}
export function runGaussNemesis81KeyRotation(input){
  if(input?.action==='sqisign-verify-key-rotation'){
    fields(input,['action','binary','expectedBinarySha256','certificate','expectedOldKeyId'],
      ['action','expectedBinarySha256','certificate','expectedOldKeyId']);
    if(typeof input.expectedOldKeyId!=='string'||!HEX.test(input.expectedOldKeyId))fail('OLD_KEY_ID');
    return {domain:'GAUSS_NEMESIS81_KEYPAIR_ROTATION_V1',
      verified:verifyCertificate(input.certificate,input.expectedOldKeyId,
        {binary:input.binary,expectedBinarySha256:input.expectedBinarySha256})};
  }
  fields(input,['action','binary','expectedBinarySha256','oldKeyPath','oldPassphrase','oldPublicKeyBase64',
    'expectedOldKeyId','newKeyPath','newPassphrase'],
    ['action','expectedBinarySha256','oldKeyPath','oldPassphrase','oldPublicKeyBase64',
      'expectedOldKeyId','newKeyPath','newPassphrase']);
  if(input.action!=='sqisign-rotate-keypair-sealed'||typeof input.expectedOldKeyId!=='string'||
     !HEX.test(input.expectedOldKeyId)||publicKey(input.oldPublicKeyBase64)!==input.expectedOldKeyId)
    fail('OLD_KEY_ID');
  if(input.oldKeyPath===input.newKeyPath)fail('NEW_KEY_PATH_REQUIRED');
  const common={binary:input.binary,expectedBinarySha256:input.expectedBinarySha256};
  // Authenticate the old key and validate its executable pin BEFORE creating a new key file.
  authenticateOld(common,input.oldKeyPath,input.oldPassphrase,input.expectedOldKeyId,input.oldPublicKeyBase64);
  // The new encrypted file is exclusive and never overwrites the old one.
  const newKey=runGaussNemesis81Sealed({action:'sqisign-keygen-sealed',...common,
    keyPath:input.newKeyPath,passphrase:input.newPassphrase});
  if(newKey.keyId===input.expectedOldKeyId)fail('IDENTICAL_KEYPAIR');
  const messageBase64=statement(input.expectedOldKeyId,newKey.keyId,newKey.publicKeyBase64);
  const old=runGaussNemesis81Sealed({action:'sqisign-sign-sealed',...common,
    keyPath:input.oldKeyPath,passphrase:input.oldPassphrase,
    expectedKeyId:input.expectedOldKeyId,messageBase64});
  const newer=runGaussNemesis81Sealed({action:'sqisign-sign-sealed',...common,
    keyPath:input.newKeyPath,passphrase:input.newPassphrase,
    expectedKeyId:newKey.keyId,messageBase64});
  if(old.publicKeyBase64!==input.oldPublicKeyBase64||newer.publicKeyBase64!==newKey.publicKeyBase64)
    fail('KEY_CHANGED');
  const certificate={version:1,domain:'GAUSS_NEMESIS81_KEYPAIR_ROTATION_V1',
    oldKeyId:input.expectedOldKeyId,oldPublicKeyBase64:input.oldPublicKeyBase64,
    newKeyId:newKey.keyId,newPublicKeyBase64:newKey.publicKeyBase64,
    oldSignatureBase64:old.signatureBase64,newSignatureBase64:newer.signatureBase64};
  if(!verifyCertificate(certificate,input.expectedOldKeyId,common))fail('TRANSITION_PROOF_FAILED');
  return {domain:'GAUSS_NEMESIS81_KEYPAIR_ROTATION_V1',rotated:true,
    certificate,newKeyId:newKey.keyId,
    caveat:'Verify this certificate using the previously trusted old key ID and approve the new public key via an authenticated channel. The old key file is not deleted.'};
}
