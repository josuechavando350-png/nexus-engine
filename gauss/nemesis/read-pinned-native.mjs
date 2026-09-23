/** Read a pinned native binary through a bounded, identity-checked regular FD.
 * A path or symlink can be replaced before open; only the opened inode is read.
 * This is a local executable integrity check, not a software supply-chain audit.
 */
import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync} from 'node:fs';
import {resolve} from 'node:path';
const MAX_BINARY=128*1024*1024;
const hex=/^[a-f0-9]{64}$/;
export function readPinnedNativeBinary(path,expected,prefix){
  if(typeof prefix!=='string'||!/^NEMESIS_[0-9]+(?:_[A-Z]+)*$/.test(prefix))throw new TypeError('invalid native error prefix');
  if(typeof path!=='string'||!path||path.includes('\0'))throw new TypeError(`${prefix}_BINARY_PATH`);
  if(typeof expected!=='string'||!hex.test(expected))throw new TypeError(`${prefix}_BINARY_PIN_FORMAT`);
  const absolute=resolve(path);
  const original=lstatSync(absolute,{throwIfNoEntry:false});
  if(!original)throw new Error(`${prefix}_BINARY_MISSING`);
  if(!original.isFile()||original.isSymbolicLink()||original.size<1||original.size>MAX_BINARY)
    throw new Error(`${prefix}_BINARY_UNSAFE`);
  let fd,bytes;
  try{
    fd=openSync(absolute,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    const actual=fstatSync(fd);
    if(!actual.isFile()||actual.dev!==original.dev||actual.ino!==original.ino||
       actual.size!==original.size||actual.size<1||actual.size>MAX_BINARY)
      throw new Error(`${prefix}_BINARY_UNSAFE`);
    bytes=Buffer.alloc(actual.size);
    let pos=0;
    while(pos<bytes.length){const read=readSync(fd,bytes,pos,bytes.length-pos,pos);
      if(read<1)throw new Error(`${prefix}_BINARY_CHANGED`);pos+=read;}
    const after=fstatSync(fd);
    if(after.dev!==actual.dev||after.ino!==actual.ino||after.size!==actual.size)
      throw new Error(`${prefix}_BINARY_CHANGED`);
    const digest=createHash('sha256').update(bytes).digest('hex');
    if(digest!==expected)throw new Error(`${prefix}_BINARY_PIN_MISMATCH`);
    const result=bytes;bytes=undefined;
    return {bytes:result,digest};
  }catch(error){
    if(error?.message?.startsWith(`${prefix}_BINARY_`))throw error;
    throw new Error(`${prefix}_BINARY_UNSAFE`);
  }finally{bytes?.fill(0);if(fd!==undefined)closeSync(fd);}
}
