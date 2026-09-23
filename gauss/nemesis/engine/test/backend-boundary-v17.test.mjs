/** Boundary/negative tests: fake binaries below are malicious-output fixtures, NOT crypto backends. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,chmodSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {compileExecutionCircuit,verifyGroth16Execution,proveGroth16Execution} from '../src/motors/execution-snark.mjs';
import {runNativeFheAdder} from '../src/motors/native-fhe-adapter.mjs';

const linuxOnly=process.platform==='win32'?test.skip:test;
const program={witnessCount:2,nodes:[{id:'n0',op:'add',left:'w0',right:'w1'}],output:'n0'};
const sha=text=>createHash('sha256').update(text).digest('hex');
function fake(dir,name,script){
 const file=join(dir,name);writeFileSync(file,'#!/bin/sh\n'+script+'\n',{mode:0o700});chmodSync(file,0o700);return file;
}
function fixture(dir,snarkjs,tools={}) {
 const verificationKey=join(dir,'key.json');writeFileSync(verificationKey,'{}');
 const pin=sha('{}'),compiled=compileExecutionCircuit(program);
 return {program,verificationKey,statement:{programSha256:compiled.programSha256,verificationKeySha256:pin,output:'3'},
   proof:{pi_a:[]},expectedProgramSha256:compiled.programSha256,expectedVerificationKeySha256:pin,
   tools:{snarkjs,...tools}};
}
linuxOnly('95: a zero-exit backend saying NOT OK! cannot yield verified=true',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nemesis-v17-false-positive-'));
 try{
  const binary=fake(dir,'fake-snarkjs','printf "[INFO] snarkJS: NOT OK!\\n"');
  const input=fixture(dir,binary);
  assert.deepEqual(verifyGroth16Execution(input),{domain:'GROTH16_BN254_EXECUTION',verified:false});
  writeFileSync(binary,'#!/bin/sh\nprintf "[INFO] snarkJS: OK! but invalid\\n"\n',{mode:0o700});
  assert.equal(verifyGroth16Execution(input).verified,false);
  writeFileSync(binary,'#!/bin/sh\nprintf "[ERROR] invalid proof\\n[INFO] snarkJS: OK!\\n"\n',{mode:0o700});
  assert.equal(verifyGroth16Execution(input).verified,false);
  writeFileSync(binary,'#!/bin/sh\nprintf "[INFO] snarkJS: OK!\\n[ERROR] invalid proof\\n"\n',{mode:0o700});
  assert.equal(verifyGroth16Execution(input).verified,false);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
linuxOnly('95: wrong independently trusted tool digest stops execution before subprocess launch',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nemesis-v17-binary-pin-'));
 try{
  const marker=join(dir,'EXECUTED');
  const binary=fake(dir,'fake-snarkjs',`touch "${marker}"\nprintf '[INFO] snarkJS: NOT OK!\\n'`);
  const input=fixture(dir,binary,{snarkjsSha256:'0'.repeat(64)});
  assert.throws(()=>verifyGroth16Execution(input),/executable failed trusted SHA-256 pin/);
  assert.equal(existsSync(marker),false);
  assert.equal(verifyGroth16Execution({...input,tools:{snarkjs:binary,snarkjsSha256:sha(readFileSync(binary))}}).verified,false);
  assert.equal(existsSync(marker),true);
  assert.throws(()=>verifyGroth16Execution({...input,tools:{snarkjs:'snarkjs',snarkjsSha256:sha(readFileSync(binary))}}),/absolute executable path/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
linuxOnly('95: misleading zkey success substring is rejected before generating a proof',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nemesis-v17-zkey-'));
 try{
  const circom=fake(dir,'fake-circom','mkdir -p "$5/nemesis95_js"\nprintf x > "$5/nemesis95.r1cs"\nprintf x > "$5/nemesis95_js/nemesis95.wasm"');
  const snarkjs=fake(dir,'fake-snarkjs','printf "[INFO] snarkJS: NOT ZKey Ok!\\n"');
  const zkey=join(dir,'key.zkey'),ptau=join(dir,'phase.ptau');writeFileSync(zkey,'not a real key');writeFileSync(ptau,'not a real ceremony');
  assert.throws(()=>proveGroth16Execution({program,witness:['1','2'],zkey,ptau,trustedVerificationKeySha256:sha('{}'),tools:{circom,snarkjs}}),/zkey verification did not confirm/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
linuxOnly('95: external verifier and prover failures do not disclose witness text in exceptions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nemesis-v17-secret-'));
 try{
  const circom=fake(dir,'fake-circom','mkdir -p "$5/nemesis95_js"\nprintf x > "$5/nemesis95.r1cs"\nprintf x > "$5/nemesis95_js/nemesis95.wasm"');
  const snarkjs=fake(dir,'fake-snarkjs',`if [ "$1" = zkey ] && [ "$2" = verify ]; then printf '[INFO] snarkJS: ZKey Ok!\\n'; exit 0; fi
if [ "$1" = zkey ] && [ "$2" = export ]; then printf '{}' > "$5"; exit 0; fi
if [ "$1" = groth16 ] && [ "$2" = fullprove ]; then cat "$3" >&2; exit 1; fi
exit 1`);
  const zkey=join(dir,'key.zkey'),ptau=join(dir,'phase.ptau');writeFileSync(zkey,'not a real key');writeFileSync(ptau,'not a real ceremony');
  assert.throws(()=>proveGroth16Execution({program,witness:['987654321','2'],zkey,ptau,trustedVerificationKeySha256:sha('{}'),tools:{circom,snarkjs}}),error=>{
    assert.match(error.message,/SNARK external tool failed/);
    assert.doesNotMatch(error.message,/987654321|"w"|\["987654321"/);
    return true;
  });
 }finally{rmSync(dir,{recursive:true,force:true});}
});
linuxOnly('89: native failed process cannot echo private stdin back through an exception',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nemesis-v17-fhe-secret-'));
 try{
  const binary=fake(dir,'fake-fhe','cat >&2\nexit 1');
  assert.throws(()=>runNativeFheAdder({action:'native-add-u8',a:123,b:234,binary}),error=>{
    assert.match(error.message,/native TFHE execution failed/);
    assert.doesNotMatch(error.message,/123 234|123|234/);
    return true;
  });
 }finally{rmSync(dir,{recursive:true,force:true});}
});
