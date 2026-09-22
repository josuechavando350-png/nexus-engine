#!/usr/bin/env node
/** Real Némesis #95 Groth16 test-only integration; no production setup keys. */
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileExecutionCircuit,canonicalSnarkJson,proveGroth16Execution,verifyGroth16Execution} from '../engine/src/motors/execution-snark.mjs';
function command(tool,args,dir){
  const result=spawnSync(tool,args,{cwd:dir,encoding:'utf8',timeout:600000,maxBuffer:2*1024*1024,shell:false,windowsHide:true});
  if(result.error||result.status!==0)throw new Error(`NEMESIS_95_TEST_TOOL_FAILED: ${tool} ${args[0]} (${result.error?.code??`exit ${result.status}`})`);
  return result;
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
  const ptau0=join(workspace,'ptau_0000.ptau'),ptau1=join(workspace,'ptau_0001.ptau');
  const ptau=join(workspace,'pot_final.ptau'),r1cs=join(workspace,'nemesis95.r1cs');
  const zkey0=join(workspace,'circuit_0000.zkey'),zkey=join(workspace,'circuit_final.zkey');
  const verificationKey=join(workspace,'verification_key.json');
  command('snarkjs',['powersoftau','new','bn128','8',ptau0],workspace);
  command('snarkjs',['powersoftau','contribute',ptau0,ptau1,'--name=NEMESIS95-CI-ONLY',`-e=${randomBytes(32).toString('hex')}`],workspace);
  command('snarkjs',['powersoftau','prepare','phase2',ptau1,ptau],workspace);
  writeFileSync(join(workspace,'nemesis95.circom'),circuit.circomSource,{mode:0o600});
  command('circom',[join(workspace,'nemesis95.circom'),'--r1cs','--wasm','-o',workspace],workspace);
  command('snarkjs',['groth16','setup',r1cs,ptau,zkey0],workspace);
  command('snarkjs',['zkey','contribute',zkey0,zkey,'--name=NEMESIS95-CI-PHASE2-ONLY',`-e=${randomBytes(32).toString('hex')}`],workspace);
  const verified=command('snarkjs',['zkey','verify',r1cs,ptau,zkey],workspace);
  // Only channel and marker booleans are logged: never print ceremony output, witness or private data.
  const clean=s=>s.replace(/\u001b\[[0-9;]*m/g,'');
  console.log(JSON.stringify({diagnostic:'ZKEY_VERIFY_CHANNELS',stdoutBytes:verified.stdout.length,stderrBytes:verified.stderr.length,stdoutSuccess:/\bZKey Ok!/i.test(clean(verified.stdout)),stderrSuccess:/\bZKey Ok!/i.test(clean(verified.stderr)),stdoutNegative:/\b(?:not\s+zkey\s+ok|invalid|failed)\b/i.test(clean(verified.stdout)),stderrNegative:/\b(?:not\s+zkey\s+ok|invalid|failed)\b/i.test(clean(verified.stderr))}));
  command('snarkjs',['zkey','export','verificationkey',zkey,verificationKey],workspace);
  const vk=JSON.parse(readFileSync(verificationKey,'utf8'));
  const testOnlyKeyPin=sha(canonicalSnarkJson(vk));
  const result=proveGroth16Execution({program,witness,ptau,zkey,trustedVerificationKeySha256:testOnlyKeyPin});
  const request={program,statement:result.statement,proof:result.proof,verificationKey,
    expectedProgramSha256:circuit.programSha256,expectedVerificationKeySha256:testOnlyKeyPin};
  assert.equal(result.statement.output,'74');
  assert.equal(verifyGroth16Execution(request).verified,true,'real Groth16 proof must verify');
  assert.equal(verifyGroth16Execution({...request,statement:{...result.statement,output:'75'}}).verified,false);
  assert.equal(verifyGroth16Execution({...request,expectedProgramSha256:'0'.repeat(64)}).verified,false);
  assert.equal(verifyGroth16Execution({...request,expectedVerificationKeySha256:'0'.repeat(64)}).verified,false);
  assert.equal(verifyGroth16Execution({...request,proof:{...result.proof,pi_a:['0',...result.proof.pi_a.slice(1)]}}).verified,false);
  console.log(JSON.stringify({motor:95,scope:'EPHEMERAL_TEST_ONLY_NOT_PRODUCTION',result:'PASS',backend:'GROTH16_BN254',programSha256:circuit.programSha256,verificationKeySha256:testOnlyKeyPin,r1csSha256:result.circuit.r1csSha256,checks:5}));
}finally{rmSync(workspace,{recursive:true,force:true});}
