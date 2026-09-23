/** GAUSS Némesis #89: optional sealed custody for the local native TFHE role CLI.
 * Linux tmpfs is mandatory for short-lived plaintext; no persistent plaintext key.
 * This is not a remote protocol, HSM, protection against a compromised host, or
 * a replacement for independently auditing the pinned tfhe implementation.
 */
import {createHash,createCipheriv,createDecipheriv,randomBytes,scryptSync} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {constants,closeSync,fstatSync,fsyncSync,lstatSync,mkdtempSync,openSync,readFileSync,rmSync,statfsSync,writeFileSync,writeSync,unlinkSync} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';
import {tmpdir} from 'node:os';
import {readPinnedNativeBinary} from './read-pinned-native.mjs';

const MAX_KEY=256*1024*1024, MAX_VAULT=360*1024*1024;
const HEX=/^[a-f0-9]{64}$/;
const sha=b=>createHash('sha256').update(b).digest('hex');
const reject=code=>{throw new Error(`NEMESIS_89_SEALED_${code}`);};
function fields(obj,allowed,required){
  if(!obj||typeof obj!=='object'||Array.isArray(obj)||Object.getPrototypeOf(obj)!==Object.prototype)reject('INPUT');
  if(Object.keys(obj).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(obj,k)))reject('FIELDS');
}
function pin(v){if(typeof v!=='string'||!HEX.test(v))reject('PIN');return v;}
function passphrase(v){if(typeof v!=='string'||Buffer.byteLength(v,'utf8')<16||Buffer.byteLength(v,'utf8')>1024)reject('PASSPHRASE');return v;}
function privateParent(path){
  if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))reject('PATH');
  const s=lstatSync(dirname(path),{throwIfNoEntry:false});
  if(!s?.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0||
     (typeof process.getuid==='function'&&s.uid!==process.getuid()))reject('PRIVATE_DIRECTORY');
}
function readPrivate(path,limit){
  privateParent(path);
  const before=lstatSync(path,{throwIfNoEntry:false});
  if(!before?.isFile()||before.isSymbolicLink()||before.nlink!==1||(before.mode&0o077)!==0||
    before.size<1||before.size>limit||(typeof process.getuid==='function'&&before.uid!==process.getuid()))reject('UNSAFE_FILE');
  let fd;
  try{
    fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    const after=fstatSync(fd);
    if(!after.isFile()||after.ino!==before.ino||after.dev!==before.dev||after.nlink!==1||
      (after.mode&0o077)!==0||after.size!==before.size)reject('UNSAFE_FILE');
    const bytes=readFileSync(fd);
    if(bytes.length!==before.size)reject('CHANGED_FILE');
    return bytes;
  }catch(e){if(e?.message?.startsWith('NEMESIS_89_SEALED_'))throw e;reject('READ');}
  finally{if(fd!==undefined)closeSync(fd);}
}
function saveNew(path,bytes){
  privateParent(path);
  let fd,identity;
  try{
    fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);
    identity=fstatSync(fd);
    let offset=0;
    while(offset<bytes.length){const written=writeSync(fd,bytes,offset,bytes.length-offset);if(written<=0)reject('WRITE');offset+=written;}
    fsyncSync(fd);
  }catch{
    if(identity){const current=lstatSync(path,{throwIfNoEntry:false});
      if(current?.dev===identity.dev&&current.ino===identity.ino){try{unlinkSync(path);}catch{}}}
    reject('PERSIST');
  }finally{if(fd!==undefined)closeSync(fd);}
  return identity;
}
function unlinkIfSame(path,identity){
  if(!identity)return;
  const current=lstatSync(path,{throwIfNoEntry:false});
  if(current?.dev===identity.dev&&current.ino===identity.ino){try{unlinkSync(path);}catch{reject('ROLLBACK');}}
}
function decode(v,len,label){
  if(typeof v!=='string'||v.length>MAX_VAULT||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v))reject(`FORMAT_${label}`);
  const b=Buffer.from(v,'base64');
  if((len!==null&&b.length!==len)||b.toString('base64')!==v){b.fill(0);reject(`FORMAT_${label}`);}
  return b;
}
function aad(id){return Buffer.from(`GAUSS-NEMESIS89-TFHE-SEAL-V1:${id}`);}
function seal(clientKey,pass,id){
  if(clientKey.length<1||clientKey.length>MAX_KEY)reject('KEY_SIZE');
  const salt=randomBytes(16),iv=randomBytes(12),key=scryptSync(passphrase(pass),salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  let ct,tag;
  try{
    const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(id));
    ct=Buffer.concat([cipher.update(clientKey),cipher.final()]);tag=cipher.getAuthTag();
    const blob=Buffer.from(JSON.stringify({version:1,algorithm:'AES-256-GCM-SCRYPT-N32768',serverKeySha256:id,
      salt:salt.toString('base64'),iv:iv.toString('base64'),tag:tag.toString('base64'),ciphertext:ct.toString('base64')}));
    if(blob.length>MAX_VAULT){blob.fill(0);reject('VAULT_SIZE');}
    return blob;
  }finally{key.fill(0);salt.fill(0);iv.fill(0);ct?.fill(0);tag?.fill(0);}
}
function unseal(vaultPath,pass,id){
  pin(id);const raw=readPrivate(vaultPath,MAX_VAULT);
  let s,iv,tag,ct,key,plain;
  try{
    let data;try{data=JSON.parse(raw.toString('utf8'));}catch{reject('FORMAT');}
    fields(data,['version','algorithm','serverKeySha256','salt','iv','tag','ciphertext'],
      ['version','algorithm','serverKeySha256','salt','iv','tag','ciphertext']);
    if(data.version!==1||data.algorithm!=='AES-256-GCM-SCRYPT-N32768'||data.serverKeySha256!==id)reject('KEY_ID');
    s=decode(data.salt,16,'SALT');iv=decode(data.iv,12,'IV');tag=decode(data.tag,16,'TAG');ct=decode(data.ciphertext,null,'CIPHERTEXT');
    if(ct.length<1||ct.length>MAX_KEY)reject('KEY_SIZE');
    key=scryptSync(passphrase(pass),s,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
    const cipher=createDecipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(id));cipher.setAuthTag(tag);
    try{plain=Buffer.concat([cipher.update(ct),cipher.final()]);}catch{reject('DECRYPT');}
    return plain;
  }finally{raw.fill(0);s?.fill(0);iv?.fill(0);tag?.fill(0);ct?.fill(0);key?.fill(0);}
}
function ramWorkspace(fn){
  if(process.platform!=='linux')reject('LINUX_REQUIRED');
  const base='/dev/shm';let stat;
  try{stat=statfsSync(base);}catch{reject('TMPFS_REQUIRED');}
  if(stat.type!==0x01021994)reject('TMPFS_REQUIRED');
  const dir=mkdtempSync(join(base,'gauss-nemesis89-'));
  try{
    const metadata=lstatSync(dir);
    if(metadata.isSymbolicLink()||(metadata.mode&0o077)!==0)reject('TMPFS_PERMISSIONS');
    return fn(dir);
  }finally{rmSync(dir,{recursive:true,force:true});}
}
function callNative(executable,args,input){
  const run=spawnSync(executable,args,{input,encoding:'utf8',timeout:240000,maxBuffer:1024*1024,shell:false,windowsHide:true});
  if(run.error||run.status!==0)reject('NATIVE_FAILED');
  return run.stdout;
}
/** The server key hash must come from a separately authenticated channel after keygen. */
export function runGaussNemesis89Sealed(input){
  fields(input,['action','binary','expectedBinarySha256','vaultPath','serverPath','ciphertextPath',
    'outputPath','serverKeySha256','passphrase','newVaultPath','newPassphrase','bits'],
    ['action','binary','expectedBinarySha256','vaultPath','passphrase']);
  const action=input.action;
  if(!['sealed-keygen','sealed-encrypt','sealed-decrypt','sealed-rekey'].includes(action))reject('ACTION');
  passphrase(input.passphrase);pin(input.expectedBinarySha256);
  if(action==='sealed-rekey'){
    fields(input,['action','vaultPath','passphrase','newVaultPath','newPassphrase','serverKeySha256','binary','expectedBinarySha256'],
      ['action','vaultPath','passphrase','newVaultPath','newPassphrase','serverKeySha256','binary','expectedBinarySha256']);
    pin(input.serverKeySha256);passphrase(input.newPassphrase);
    if(input.vaultPath===input.newVaultPath)reject('NEW_PATH');
    let plaintext,blob;
    try{
      plaintext=unseal(input.vaultPath,input.passphrase,input.serverKeySha256);
      blob=seal(plaintext,input.newPassphrase,input.serverKeySha256);
      saveNew(input.newVaultPath,blob);
      return {domain:'TFHE_BOOLEAN_SEALED_LOCAL',serverKeySha256:input.serverKeySha256,rotated:true};
    }finally{plaintext?.fill(0);blob?.fill(0);}
  }
  return ramWorkspace(dir=>{
    // The pinned executable can live on a normal executable mount; the only
    // plaintext client key is restricted to verified Linux tmpfs.
    const execDir=mkdtempSync(join(tmpdir(),'gauss-nemesis89-exec-'));
    const client=join(dir,'client.key'),server=join(dir,'server.key'),snapshot=join(execDir,'nemesis89_roles');
    let binaryBytes,clientBytes,serverBytes,blob;
    try{
      if(typeof input.binary!=='string'||!isAbsolute(input.binary)||input.binary.includes('\0'))reject('BINARY_PATH');
      binaryBytes=readPinnedNativeBinary(input.binary,input.expectedBinarySha256,'NEMESIS_89_SEALED').bytes;
      writeFileSync(snapshot,binaryBytes,{flag:'wx',mode:0o700});
      if(action==='sealed-keygen'){
        fields(input,['action','binary','expectedBinarySha256','vaultPath','serverPath','passphrase'],
          ['action','binary','expectedBinarySha256','vaultPath','serverPath','passphrase']);
        privateParent(input.vaultPath);privateParent(input.serverPath);
        if(lstatSync(input.vaultPath,{throwIfNoEntry:false})||lstatSync(input.serverPath,{throwIfNoEntry:false}))reject('FILE_EXISTS');
        if(callNative(snapshot,['keygen',client,server])!=='')reject('UNEXPECTED_NATIVE_OUTPUT');
        clientBytes=readPrivate(client,MAX_KEY);serverBytes=readPrivate(server,MAX_KEY);
        const id=sha(serverBytes);blob=seal(clientBytes,input.passphrase,id);
        const saved=saveNew(input.vaultPath,blob);
        try{saveNew(input.serverPath,serverBytes);}catch(error){unlinkIfSame(input.vaultPath,saved);throw error;}
        return {domain:'TFHE_BOOLEAN_SEALED_LOCAL',serverKeySha256:id,vaultEncrypted:true};
      }
      fields(input,['action','binary','expectedBinarySha256','vaultPath','passphrase','serverKeySha256','bits','ciphertextPath','outputPath'],
        action==='sealed-encrypt'?['action','binary','expectedBinarySha256','vaultPath','passphrase','serverKeySha256','bits','ciphertextPath']:
        ['action','binary','expectedBinarySha256','vaultPath','passphrase','serverKeySha256','outputPath']);
      pin(input.serverKeySha256);
      clientBytes=unseal(input.vaultPath,input.passphrase,input.serverKeySha256);
      saveNew(client,clientBytes);
      if(action==='sealed-encrypt'){
        if(typeof input.bits!=='string'||! /^[01]{1,128}$/.test(input.bits))reject('BITS');
        if(callNative(snapshot,['encrypt',client,input.ciphertextPath],input.bits)!=='')reject('UNEXPECTED_NATIVE_OUTPUT');
        return {domain:'TFHE_BOOLEAN_SEALED_LOCAL',serverKeySha256:input.serverKeySha256,ciphertextWritten:true};
      }
      const answer=callNative(snapshot,['decrypt',client,input.outputPath]);
      if(!/^[01]{1,128}\n$/.test(answer))reject('INVALID_NATIVE_OUTPUT');
      return {domain:'TFHE_BOOLEAN_SEALED_LOCAL',serverKeySha256:input.serverKeySha256,bits:answer.trim()};
    }finally{binaryBytes?.fill(0);clientBytes?.fill(0);serverBytes?.fill(0);blob?.fill(0);rmSync(execDir,{recursive:true,force:true});}
  });
}
