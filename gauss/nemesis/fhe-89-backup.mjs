/** GAUSS/Némesis #89: authenticated, encrypted, copy-on-write local recovery set.
 * The existing vault is decrypted and re-encrypted with fresh salt/nonce via the
 * tested sealed-rekey action. The server key is public but identity-pinned.
 * Backup digests must be retained by the operator outside the backed-up host.
 */
import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,fsyncSync,lstatSync,openSync,readSync,unlinkSync,writeSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import {runGaussNemesis89Sealed} from './fhe-89-sealed.mjs';

const MAX_SERVER=256*1024*1024,MAX_VAULT=360*1024*1024;
const SHA=/^[a-f0-9]{64}$/;
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw new Error(`NEMESIS_89_BACKUP_${code}`);};
function shape(v,allowed){
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype||
    Object.keys(v).some(k=>!allowed.includes(k))||allowed.some(k=>!Object.hasOwn(v,k)))fail('INPUT');
}
function privateParent(path){
  if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))fail('PATH');
  const dir=lstatSync(dirname(path),{throwIfNoEntry:false});
  if(!dir?.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)!==0||
    (typeof process.getuid==='function'&&dir.uid!==process.getuid()))fail('PRIVATE_DIRECTORY');
}
// Never open an unbounded stream, follow a symlink, accept hardlinked secrets,
// or trust a pathname after it has been replaced by another inode.
function readBounded(path,max){
  privateParent(path);
  const before=lstatSync(path,{throwIfNoEntry:false});
  if(!before?.isFile()||before.isSymbolicLink()||before.nlink!==1||
    (before.mode&0o077)!==0||before.size<1||before.size>max||
    (typeof process.getuid==='function'&&before.uid!==process.getuid()))fail('UNSAFE_FILE');
  let fd,bytes;
  try{
    fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    const opened=fstatSync(fd);
    if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||
       opened.nlink!==1||(opened.mode&0o077)!==0)fail('UNSAFE_FILE');
    bytes=Buffer.alloc(opened.size);
    let offset=0;
    while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,offset);
      if(n<1)fail('CHANGED_FILE');offset+=n;}
    const after=fstatSync(fd);
    if(after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size)fail('CHANGED_FILE');
    const result=bytes;bytes=undefined;return result;
  }finally{bytes?.fill(0);if(fd!==undefined)closeSync(fd);}
}
function createNew(path,bytes){
  privateParent(path);
  let fd,identity;
  try{
    fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
    identity=fstatSync(fd);
    let at=0;
    while(at<bytes.length){const n=writeSync(fd,bytes,at,bytes.length-at);if(n<1)fail('WRITE');at+=n;}
    fsyncSync(fd);
    return identity;
  }catch{
    if(identity){const current=lstatSync(path,{throwIfNoEntry:false});
      if(current?.dev===identity.dev&&current.ino===identity.ino){try{unlinkSync(path);}catch{/* Cleanup is best-effort; preserve PERSIST error. */}}}
    fail('PERSIST');
  }finally{if(fd!==undefined)closeSync(fd);}
}
function rollback(path,identity){
  const s=lstatSync(path,{throwIfNoEntry:false});
  if(s?.dev===identity.dev&&s.ino===identity.ino){try{unlinkSync(path);}catch{fail('ROLLBACK');}}
  else fail('ROLLBACK_IDENTITY_CHANGED');
}
export function runGaussNemesis89Backup(input){
  shape(input,['action','binary','expectedBinarySha256','vaultPath','serverPath','passphrase',
    'serverKeySha256','backupVaultPath','backupServerPath','backupPassphrase']);
  if(input.action!=='sealed-backup'||typeof input.serverKeySha256!=='string'||
    !SHA.test(input.serverKeySha256))fail('INPUT');
  if(input.vaultPath===input.backupVaultPath||input.serverPath===input.backupServerPath||
    input.backupVaultPath===input.backupServerPath)fail('DESTINATION');
  privateParent(input.backupVaultPath);privateParent(input.backupServerPath);
  if(lstatSync(input.backupVaultPath,{throwIfNoEntry:false})||
     lstatSync(input.backupServerPath,{throwIfNoEntry:false}))fail('DESTINATION_EXISTS');
  const server=readBounded(input.serverPath,MAX_SERVER);
  try{
    if(sha(server)!==input.serverKeySha256)fail('SERVER_PIN_MISMATCH');
    // Create a publicly usable server-key copy first. If authenticating the
    // encrypted private key fails, remove only the server copy we created.
    const created=createNew(input.backupServerPath,server);
    try{
      runGaussNemesis89Sealed({action:'sealed-rekey',binary:input.binary,
        expectedBinarySha256:input.expectedBinarySha256,vaultPath:input.vaultPath,
        passphrase:input.passphrase,newVaultPath:input.backupVaultPath,
        newPassphrase:input.backupPassphrase,serverKeySha256:input.serverKeySha256});
    }catch(error){rollback(input.backupServerPath,created);throw error;}
    const vault=readBounded(input.backupVaultPath,MAX_VAULT);
    try{return {domain:'TFHE_BOOLEAN_SEALED_LOCAL',backupReady:true,
      serverKeySha256:input.serverKeySha256,backupVaultSha256:sha(vault),
      backupServerSha256:sha(server)};}
    finally{vault.fill(0);}
  }finally{server.fill(0);}
}
