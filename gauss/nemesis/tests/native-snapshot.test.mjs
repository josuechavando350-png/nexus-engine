import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runGaussNemesis89} from '../native-fhe.mjs';

test('GAUSS #89 executes verified private binary snapshot rather than replaceable source path',()=>{
 if(process.platform==='win32')return;
 const dir=mkdtempSync(join(tmpdir(),'gauss-nemesis89-snapshot-'));
 try{
  const binary=join(dir,'replaceable-bin'),marker=join(dir,'executed-path');
  const script=`#!/bin/sh\nprintf '%s\\n' "$0" > '${marker}'\nprintf '%s\\n' '{"motor":89,"backend":"TFHE_BOOLEAN","sum":3,"verified":true}'\n`;
  writeFileSync(binary,script,{mode:0o700});
  const expectedBinarySha256=createHash('sha256').update(script).digest('hex');
  const result=runGaussNemesis89({action:'native-add-u8',a:1,b:2,binary,expectedBinarySha256});
  assert.equal(result.sum,3);
  const executedPath=readFileSync(marker,'utf8').trim();
  assert.notEqual(executedPath,binary,'must never execute the replaceable source path');
  assert.match(executedPath,/gauss-nemesis89-/);
  assert.equal(existsSync(executedPath),false,'temporary executable must be cleaned up');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
