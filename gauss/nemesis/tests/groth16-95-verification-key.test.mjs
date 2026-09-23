import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runGaussNemesis} from '../bridge.mjs';
import {canonicalSnarkJson, compileExecutionCircuit} from '../engine/src/motors/execution-snark.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const program={witnessCount:1,nodes:[],output:'w0'};

test('95: never hand an unbounded or mutable verification key to the Groth16 verifier',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'nemesis95-vk-negative-'));
  try{
    const vk=join(dir,'verification_key.json');
    writeFileSync(vk,JSON.stringify({testOnly:true}));
    const request={action:'verify-pinned',program,statement:{programSha256:'0'.repeat(64),verificationKeySha256:'0'.repeat(64),output:'1'},
      proof:{},verificationKey:vk,expectedProgramSha256:compileExecutionCircuit(program).programSha256,
      expectedVerificationKeySha256:hash(canonicalSnarkJson({testOnly:true})),
      // No native backend is ever launched by any of these negative assertions.
      tools:{snarkjs:process.execPath,snarkjsSha256:'0'.repeat(64)}};
    const link=join(dir,'link.json');symlinkSync(vk,link);
    await assert.rejects(()=>runGaussNemesis(95,{...request,verificationKey:link}),/ARTIFACT_TYPE_OR_SIZE/);
    const huge=join(dir,'huge.json');writeFileSync(huge,'x'.repeat(1024*1024+1));
    await assert.rejects(()=>runGaussNemesis(95,{...request,verificationKey:huge}),/ARTIFACT_TYPE_OR_SIZE/);
    const invalid=join(dir,'invalid.json');writeFileSync(invalid,'{unparseable');
    await assert.rejects(()=>runGaussNemesis(95,{...request,verificationKey:invalid}),/VERIFICATION_KEY_JSON/);
    await assert.rejects(()=>runGaussNemesis(95,{...request,expectedVerificationKeySha256:'f'.repeat(64)}),/VERIFICATION_KEY_PIN_MISMATCH/);
    const folder=join(dir,'folder');
    await assert.rejects(()=>runGaussNemesis(95,{...request,verificationKey:dir}),/ARTIFACT_TYPE_OR_SIZE/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
