#!/usr/bin/env node
/**
 * Actual Némesis #95 Groth16 integration proof, using an EPHEMERAL, TEST-ONLY
 * ceremony. This never creates, endorses or certifies production setup keys.
 * Required CLI tools: circom (Circom >= 2.1.6) and snarkjs.
 */
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileExecutionCircuit,canonicalSnarkJson,proveGroth16Execution,verifyGroth16Execution} from '../engine/src/motors/execution-snark.mjs';

function command(tool,args,dir){
  const result=spawnSync(tool,args,{cwd:dir,encoding:'utf8',timeout:600000,maxBuffer:2*1024*1024,shell:false,windowsHide:true});
  if(result.error||result.status!==0){
    // Tool output may contain toxic setup material; do not echo stdout/stderr.
    throw new Error(`NEMESIS_95_TEST_TOOL_FAILED: ${tool} ${args[0]} (${result.error?.code??`exit ${result.status}`})`);
  }
}
const program={witnessCount:3,nodes:[
  {id:'n0',op:'mul',left:'w0',right:'w1'},
  {id:'n1',op:'sub',left:'n0',right:{const:'3'}},
  {id:'n2',op:'select',cond:'w2',whenTrue:'n1',whenFalse:'w0'}
],output:'n2'};
const witness=['7','11','1'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const workspace=mkdtempSync(join(tmpdir(),'gauss-nemesis95-e2e-'));
try{
  const circuit=compileExecutionCircuit(program);
  const ptau0=join(workspace,'ptau_0000.ptau');
  const ptau1=join(workspace,'ptau_0001.ptau');
  const ptau=join(workspace,'pot_final.ptau');
  const r1cs=join(workspace,'nemesis95.r1cs');
  const zkey0=join(workspace,'circuit_0000.zkey');
  const zkey=join(workspace,'circuit_final.zkey');
  const verificationKey=join(workspace,'verification_key.json');
  // 2^8 supports this small circuit. Random contributions are disposable CI fixtures,
  // not a multiparty ceremony or independently trusted production parameters.
  command('snarkjs',['powersoftau','new','bn128','8',ptau0],workspace);
  command('snarkjs',['powersoftau','contribute',ptau0,ptau1,'--name=NEMESIS95-CI-ONLY',`-e=${randomBytes(32).toString('hex')}`],workspace);
  command('snarkjs',['powersoftau','prepare','phase2',ptau1,ptau],workspace);
  // Use the same compiler source as the actual prover, never a stand-in circuit.
  writeFileSync(join(workspace,'nemesis95.circom'),circuit.circomSource,{mode:0o600});
  command('circom',[join(workspace,'nemesis95.circom'),'--r1cs','--wasm','-o',workspace],workspace);
  command('snarkjs',['groth16','setup',r1cs,ptau,zkey0],workspace);
  command('snarkjs',['zkey','contribute',zkey0,zkey,'--name=NEMESIS95-CI-PHASE2-ONLY',`-e=${randomBytes(32).toString('hex')}`],workspace);
  command('snarkjs',['zkey','verify',r1cs,ptau,zkey],workspace);
  command('snarkjs',['zkey','export','verificationkey',zkey,verificationKey],workspace);
  const vk=JSON.parse(readFileSync(verificationKey,'utf8'));
  const testOnlyKeyPin=sha(canonicalSnarkJson(vk));
  // The pin is from an independently spawned test-setup step; users must instead
  // supply a production trust anchor obtained and checked out of band.
  const result=proveGroth16Execution({program,witness,ptau,zkey,trustedVerificationKeySha256:testOnlyKeyPin});
  const request={program,statement:result.statement,proof:result.proof,verificationKey,
    expectedProgramSha256:circuit.programSha256,expectedVerificationKeySha256:testOnlyKeyPin};
  assert.equal(result.statement.output,'74');
  assert.equal(verifyGroth16Execution(request).verified,true,'real Groth16 proof must verify');
  assert.equal(verifyGroth16Execution({...request,statement:{...result.statement,output:'75'}}).verified,false,'altered public output must fail');
  assert.equal(verifyGroth16Execution({...request,expectedProgramSha256:'0'.repeat(64)}).verified,false,'altered program pin must fail');
  assert.equal(verifyGroth16Execution({...request,expectedVerificationKeySha256:'0'.repeat(64)}).verified,false,'altered verification key pin must fail');
  assert.equal(verifyGroth16Execution({...request,proof:{...result.proof,pi_a:['0',...result.proof.pi_a.slice(1)]}}).verified,false,'altered Groth16 proof must fail');
  console.log(JSON.stringify({motor:95,scope:'EPHEMERAL_TEST_ONLY_NOT_PRODUCTION',result:'PASS',
    backend:'GROTH16_BN254',programSha256:circuit.programSha256,verificationKeySha256:testOnlyKeyPin,
    r1csSha256:result.circuit.r1csSha256,checks:5}));
}finally{
  rmSync(workspace,{recursive:true,force:true});
}
