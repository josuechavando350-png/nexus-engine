import test from 'node:test';
import assert from 'node:assert/strict';
import {closeSync,ftruncateSync,mkdtempSync,openSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runGaussNemesis95Pinned} from '../groth16-95-pinned.mjs';
import {compileExecutionCircuit} from '../engine/src/motors/execution-snark.mjs';

test('95: never read a device or unbounded file as a proof tool; allow regular-file npm symlinks',()=>{
  const dir=mkdtempSync(join(tmpdir(),'nemesis95-tool-types-'));
  const program={witnessCount:1,nodes:[],output:'w0'};
  const request={action:'verify-pinned',program,expectedProgramSha256:compileExecutionCircuit(program).programSha256,
    statement:{},proof:{},verificationKey:'/intentionally-missing-verification-key',
    expectedVerificationKeySha256:'a'.repeat(64),tools:{snarkjs:'/dev/null',snarkjsSha256:'b'.repeat(64)}};
  try{
    assert.throws(()=>runGaussNemesis95Pinned(request),/TOOL_TYPE_OR_SIZE/);
    const oversized=join(dir,'oversized-snarkjs');
    const fd=openSync(oversized,'w',0o600);
    try{ftruncateSync(fd,64*1024*1024+1);}finally{closeSync(fd);}
    assert.throws(()=>runGaussNemesis95Pinned({...request,
      tools:{...request.tools,snarkjs:oversized}}),/TOOL_TYPE_OR_SIZE/);
    const ordinary=join(dir,'regular-script');
    writeFileSync(ordinary,'#!/usr/bin/env node\n',{mode:0o700});
    const alias=join(dir,'npm-bin-link');symlinkSync(ordinary,alias);
    assert.throws(()=>runGaussNemesis95Pinned({...request,
      tools:{snarkjs:alias,snarkjsSha256:'0'.repeat(64)}}),/ARTIFACT_TYPE_OR_SIZE/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
