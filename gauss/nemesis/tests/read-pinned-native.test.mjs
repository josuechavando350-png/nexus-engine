import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {closeSync,ftruncateSync,mkdtempSync,openSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readPinnedNativeBinary} from '../read-pinned-native.mjs';

test('81 and 89 native reader rejects symlinks, devices, large files and wrong bytes',()=>{
  const dir=mkdtempSync(join(tmpdir(),'nemesis-native-reader-test-'));
  try{
    const binary=join(dir,'regular-file');writeFileSync(binary,'KNOWN_BINARY_BYTES');
    const pin=createHash('sha256').update('KNOWN_BINARY_BYTES').digest('hex');
    const read=readPinnedNativeBinary(binary,pin,'NEMESIS_81_NATIVE');
    assert.equal(read.bytes.toString(),'KNOWN_BINARY_BYTES');read.bytes.fill(0);
    assert.throws(()=>readPinnedNativeBinary(binary,'0'.repeat(64),'NEMESIS_81_NATIVE'),/PIN_MISMATCH/);
    const symlink=join(dir,'link');symlinkSync(binary,symlink);
    assert.throws(()=>readPinnedNativeBinary(symlink,pin,'NEMESIS_89_SEALED'),/BINARY_UNSAFE/);
    assert.throws(()=>readPinnedNativeBinary('/dev/null',pin,'NEMESIS_89_SEALED'),/BINARY_UNSAFE/);
    const huge=join(dir,'huge');const fd=openSync(huge,'w');
    try{ftruncateSync(fd,128*1024*1024+1);}finally{closeSync(fd);}
    assert.throws(()=>readPinnedNativeBinary(huge,pin,'NEMESIS_81_NATIVE'),/BINARY_UNSAFE/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
