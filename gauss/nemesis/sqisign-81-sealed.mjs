/** Local encrypted-at-rest key custody for GAUSS/Némesis #81.
 * This is a single-host key file, not an HSM, an audited KMS or an SQIsign implementation.
 * The caller supplies the passphrase out of band; neither it nor the secret key is returned.
 */
import {createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv} from 'node:crypto';
import {constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync} from 'node:fs';
import {dirname, isAbsolute} from 'node:path';
import {runGaussNemesis81Signature} from './native-sqisign-81.mjs';

const VERSION=1;
const MAX_VAULT_BYTES=4096;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const keyId=publicKey=>hash(Buffer.concat([Buffer.from('NEMESIS81-PUBLIC-KEY-V1\0'),publicKey]));
const fail=message=>{throw new Error(`NEMESIS_81_VAULT_${message}`);};
function requireFields(input,allowed,required){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.getPrototypeOf(input)!==Object.prototype)fail('INVALID_INPUT');
  for(const k of Object.keys(input))if(!allowed.includes(k))fail('UNEXPECTED_FIELD');
  for(const k of required)if(!Object.hasOwn(input,k))fail('MISSING_FIELD');
}
function passphrase(value){
  if(typeof value!=='string'||Buffer.byteLength(value,'utf8')<16||Buffer.byteLength(value,'utf8')>1024)fail('INVALID_PASSPHRASE');
  return value;
}
function secureParent(path){
  if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))fail('INVALID_PATH');
  const parent=lstatSync(dirname(path),{throwIfNoEntry:false});
  if(!parent?.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077)!==0||
      (typeof process.getuid==='function'&&parent.uid!==process.getuid()))fail('UNSAFE_DIRECTORY');
}
function canonicalBase64(value,size){
  if(typeof value!=='string'||value.length>MAX_VAULT_BYTES||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('INVALID_ENCODING');
  const bytes=Buffer.from(value,'base64');
  if(bytes.length!==size||bytes.toString('base64')!==value){bytes.fill(0);fail('INVALID_ENCODING');}
  return bytes;
}
function derive(pass,salt){return scryptSync(pass,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});}
function aad(publicKeyBase64,id){return Buffer.from(`NEMESIS81-SEALED-V1:${id}:${publicKeyBase64}`,'utf8');}
function persist(path,data){
  secureParent(path);
  const text=Buffer.from(JSON.stringify(data));
  if(text.length>MAX_VAULT_BYTES)fail('OVERSIZE');
  let fd,created;
  try{
    fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL| (constants.O_NOFOLLOW??0),0o600);
    created=fstatSync(fd);
    if(!created.isFile()||(created.mode&0o077)!==0)fail('UNSAFE_FILE');
    let offset=0;
    while(offset<text.length){const count=writeSync(fd,text,offset,text.length-offset);if(count<=0)fail('WRITE_FAILED');offset+=count;}
    fsyncSync(fd);
  }catch{
    if(fd!==undefined&&created){
      const current=lstatSync(path,{throwIfNoEntry:false});
      if(current&&current.dev===created.dev&&current.ino===created.ino){try{unlinkSync(path);}catch{}}
    }
    fail('PERSIST_FAILED');
  }finally{if(fd!==undefined)closeSync(fd);text.fill(0);}
}
function readVault(path){
  secureParent(path);
  const before=lstatSync(path,{throwIfNoEntry:false});
  if(!before?.isFile()||before.isSymbolicLink()||before.nlink!==1||(before.mode&0o077)!==0||
     (typeof process.getuid==='function'&&before.uid!==process.getuid())||before.size>MAX_VAULT_BYTES)fail('UNSAFE_FILE');
  let fd;
  try{
    fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    const actual=fstatSync(fd);
    if(!actual.isFile()||actual.dev!==before.dev||actual.ino!==before.ino||actual.nlink!==1||
       (actual.mode&0o077)!==0||actual.size>MAX_VAULT_BYTES)fail('UNSAFE_FILE');
    const data=JSON.parse(readFileSync(fd,'utf8'));
    requireFields(data,['version','algorithm','keyId','publicKeyBase64','salt','iv','tag','ciphertext'],
      ['version','algorithm','keyId','publicKeyBase64','salt','iv','tag','ciphertext']);
    if(data.version!==VERSION||data.algorithm!=='AES-256-GCM-SCRYPT-N32768'||typeof data.keyId!=='string'||! /^[a-f0-9]{64}$/.test(data.keyId))fail('INVALID_FORMAT');
    const publicKey=canonicalBase64(data.publicKeyBase64,83);
    try{if(keyId(publicKey)!==data.keyId)fail('PUBLIC_KEY_ID_MISMATCH');}finally{publicKey.fill(0);}
    for(const [field,length] of [['salt',16],['iv',12],['tag',16],['ciphertext',270]]){
      const bytes=canonicalBase64(data[field],length);bytes.fill(0);
    }
    return data;
  }catch(error){if(error?.message?.startsWith('NEMESIS_81_VAULT_'))throw error;fail('READ_FAILED');}
  finally{if(fd!==undefined)closeSync(fd);}
}
export function runGaussNemesis81Sealed(input){
  requireFields(input,['action','binary','expectedBinarySha256','keyPath','passphrase','messageBase64','expectedKeyId'],
    ['action','expectedBinarySha256','keyPath','passphrase']);
  const common={binary:input.binary,expectedBinarySha256:input.expectedBinarySha256};
  const pass=passphrase(input.passphrase);
  if(input.action==='sqisign-keygen-sealed'){
    requireFields(input,['action','binary','expectedBinarySha256','keyPath','passphrase'],
      ['action','expectedBinarySha256','keyPath','passphrase']);
    secureParent(input.keyPath);
    if(lstatSync(input.keyPath,{throwIfNoEntry:false}))fail('FILE_EXISTS');
    const result=runGaussNemesis81Signature({action:'sqisign-keygen',...common});
    const privateKey=canonicalBase64(result.secretKeyBase64,270);
    const publicKey=canonicalBase64(result.publicKeyBase64,83);
    let derived;
    try{
      const id=keyId(publicKey),salt=randomBytes(16),iv=randomBytes(12);
      derived=derive(pass,salt);
      const cipher=createCipheriv('aes-256-gcm',derived,iv);
      cipher.setAAD(aad(result.publicKeyBase64,id));
      const ciphertext=Buffer.concat([cipher.update(privateKey),cipher.final()]);
      const tag=cipher.getAuthTag();
      persist(input.keyPath,{version:VERSION,algorithm:'AES-256-GCM-SCRYPT-N32768',keyId:id,
        publicKeyBase64:result.publicKeyBase64,salt:salt.toString('base64'),iv:iv.toString('base64'),
        tag:tag.toString('base64'),ciphertext:ciphertext.toString('base64')});
      ciphertext.fill(0);tag.fill(0);salt.fill(0);iv.fill(0);
      return {domain:'SQISIGN_P324_3_SEALED_LOCAL',publicKeyBase64:result.publicKeyBase64,keyId:id,
        binarySha256:result.binarySha256};
    }finally{derived?.fill(0);privateKey.fill(0);publicKey.fill(0);}
  }
  if(input.action==='sqisign-sign-sealed'){
    requireFields(input,['action','binary','expectedBinarySha256','keyPath','passphrase','messageBase64','expectedKeyId'],
      ['action','expectedBinarySha256','keyPath','passphrase','messageBase64','expectedKeyId']);
    if(typeof input.expectedKeyId!=='string'||! /^[a-f0-9]{64}$/.test(input.expectedKeyId))fail('INVALID_KEY_ID');
    const record=readVault(input.keyPath);
    if(record.keyId!==input.expectedKeyId)fail('KEY_ID_MISMATCH');
    const salt=canonicalBase64(record.salt,16),iv=canonicalBase64(record.iv,12),tag=canonicalBase64(record.tag,16),ct=canonicalBase64(record.ciphertext,270);
    let derived,privateKey;
    try{
      derived=derive(pass,salt);
      const decipher=createDecipheriv('aes-256-gcm',derived,iv);
      decipher.setAAD(aad(record.publicKeyBase64,record.keyId));decipher.setAuthTag(tag);
      try{privateKey=Buffer.concat([decipher.update(ct),decipher.final()]);}catch{fail('DECRYPT_FAILED');}
      if(privateKey.length!==270)fail('INVALID_KEY_LENGTH');
      const signed=runGaussNemesis81Signature({action:'sqisign-sign',...common,
        secretKeyBase64:privateKey.toString('base64'),messageBase64:input.messageBase64});
      return {domain:'SQISIGN_P324_3_SEALED_LOCAL',signatureBase64:signed.signatureBase64,
        publicKeyBase64:record.publicKeyBase64,keyId:record.keyId,binarySha256:signed.binarySha256};
    }finally{derived?.fill(0);privateKey?.fill(0);salt.fill(0);iv.fill(0);tag.fill(0);ct.fill(0);}
  }
  fail('UNSUPPORTED_ACTION');
}
