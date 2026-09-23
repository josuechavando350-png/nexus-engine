import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runGaussNemesis89} from '../native-fhe.mjs';
const bad=()=>'/nonexistent/nemesis-89';
const pinned='a'.repeat(64);
test('GAUSS #89 requires trusted binary SHA-256 pin and rejects missing binary',()=>{
 assert.throws(()=>runGaussNemesis89({action:'native-add-u8',a:1,b:2}),/expectedBinarySha256/);
 assert.throws(()=>runGaussNemesis89({action:'native-add-u8',a:1,b:2,expectedBinarySha256:pinned,binary:bad()}),/BINARY_MISSING/);
 assert.throws(()=>runGaussNemesis89({action:'native-add-u8',a:256,b:2,expectedBinarySha256:pinned,binary:bad()}),/unsigned byte/);
});
test('GAUSS #89 rejects malformed circuits before executing the binary',()=>{
 const base={action:'native-circuit',expectedBinarySha256:pinned,inputs:[true,false],gates:[{op:'xor',a:0,b:1}],outputs:[2],binary:bad()};
 assert.throws(()=>runGaussNemesis89(base),/BINARY_MISSING/);
 for(const patch of [{gates:[{op:'xor',a:0,b:2}]},{gates:[{op:'exec',a:0,b:1}]},{outputs:[3]},{inputs:[1,false]},{gates:[{op:'xor',a:0,b:1,secret:1}]}])
  assert.throws(()=>runGaussNemesis89({...base,...patch}),/wire|operation|booleans|unsupported/);
});
test('GAUSS #89 detects false native answers and mismatched binary pin',()=>{
 if(process.platform==='win32')return;
 const dir=mkdtempSync(join(tmpdir(),'gauss-nemesis89-'));
 try{
  const binary=join(dir,'forged');const content='#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' \'{"motor":89,"backend":"TFHE_BOOLEAN","sum":999,"verified":true}\'\n';
  writeFileSync(binary,content);chmodSync(binary,0o700);
  const sha=createHash('sha256').update(content).digest('hex');
  assert.throws(()=>runGaussNemesis89({action:'native-add-u8',a:1,b:2,binary,expectedBinarySha256:pinned}),/PIN_MISMATCH/);
  assert.throws(()=>runGaussNemesis89({action:'native-add-u8',a:1,b:2,binary,expectedBinarySha256:sha}),/SUM_MISMATCH/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('GAUSS #89 public native route refuses nonregular and symlinked executable paths',()=>{
 if(process.platform!=='linux')return;
 const dir=mkdtempSync(join(tmpdir(),'gauss-nemesis89-filetypes-'));
 try{
  const original=join(dir,'regular');writeFileSync(original,'#!/bin/sh\nexit 0\n',{mode:0o700});
  const link=join(dir,'link');symlinkSync(original,link);
  const request={action:'native-add-u8',a:1,b:2,expectedBinarySha256:pinned};
  assert.throws(()=>runGaussNemesis89({...request,binary:link}),/BINARY_UNSAFE/);
  assert.throws(()=>runGaussNemesis89({...request,binary:'/dev/null'}),/BINARY_UNSAFE/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
