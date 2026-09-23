import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runGaussNemesis} from '../bridge.mjs';
import {compileExecutionCircuit} from '../engine/src/motors/execution-snark.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const program={witnessCount:1,nodes:[],output:'w0'};
const expectedProgramSha256=compileExecutionCircuit(program).programSha256;

test('95: GAUSS pinned prover refuses forged trust anchors, changed setup, symlinks and absent tool pins before launching a backend',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'nemesis95-pinned-negative-'));
  try{
    const ptau=join(dir,'test-only.ptau'),zkey=join(dir,'test-only.zkey');
    // Invalid fixtures are used EXCLUSIVELY for pre-execution rejection tests.
    writeFileSync(ptau,'NOT A REAL PTAU');writeFileSync(zkey,'NOT A REAL ZKEY');
    const request={action:'prove-pinned',program,witness:['1'],ptau,zkey,
      expectedProgramSha256,expectedPtauSha256:sha('NOT A REAL PTAU'),
      expectedZkeySha256:sha('NOT A REAL ZKEY'),trustedVerificationKeySha256:'a'.repeat(64),
      tools:{circom:process.execPath,snarkjs:process.execPath,circomSha256:'b'.repeat(64),snarkjsSha256:'c'.repeat(64)}};
    await assert.rejects(()=>runGaussNemesis(95,{...request,expectedProgramSha256:'0'.repeat(64)}),/PROGRAM_PIN_MISMATCH/);
    await assert.rejects(()=>runGaussNemesis(95,{...request,expectedPtauSha256:'0'.repeat(64)}),/ARTIFACT_PIN_MISMATCH/);
    await assert.rejects(()=>runGaussNemesis(95,{...request,expectedZkeySha256:'0'.repeat(64)}),/ARTIFACT_PIN_MISMATCH/);
    const link=join(dir,'link.ptau');symlinkSync(ptau,link);
    await assert.rejects(()=>runGaussNemesis(95,{...request,ptau:link}),/ARTIFACT_TYPE_OR_SIZE/);
    await assert.rejects(()=>runGaussNemesis(95,{...request,
      tools:{...request.tools,circomSha256:undefined}}),/INVALID_DIGEST/);
    await assert.rejects(()=>runGaussNemesis(95,{...request,extra:true}),/UNEXPECTED_FIELD/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
