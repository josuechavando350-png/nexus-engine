/** GAUSS/Némesis #95: strict, separately supplied Groth16 artifact identity.
 * A caller-controlled digest is not by itself independent provenance or a
 * production-trusted multiparty ceremony. The original prover remains Circom/snarkjs.
 */
import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {canonicalSnarkJson, compileExecutionCircuit, proveGroth16Execution, verifyGroth16Execution} from './engine/src/motors/execution-snark.mjs';

const MAX_ARTIFACT=512*1024*1024;
// A BN254 Groth16 verification key is small; never parse unbounded or device-backed JSON.
const MAX_VERIFICATION_KEY=1024*1024;
const MAX_TOOL_BYTES=64*1024*1024;
const SHA=/^[a-f0-9]{64}$/;
const fail=code=>{throw new Error(`NEMESIS_95_PINNED_${code}`);};
function shape(v,allowed,required){
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('INVALID_INPUT');
  for(const k of Object.keys(v))if(!allowed.includes(k))fail('UNEXPECTED_FIELD');
  for(const k of required)if(!Object.hasOwn(v,k))fail('MISSING_FIELD');
}
function digest(value){if(typeof value!=='string'||!SHA.test(value))fail('INVALID_DIGEST');return value;}
function toolchain(tools,proving){
  shape(tools,['circom','snarkjs','circomSha256','snarkjsSha256'],proving?
    ['circom','snarkjs','circomSha256','snarkjsSha256']:['snarkjs','snarkjsSha256']);
  for(const name of proving?['circom','snarkjs']:['snarkjs']){
    if(typeof tools[name]!=='string'||!isAbsolute(tools[name]))fail('TOOL_MUST_BE_ABSOLUTE');
    digest(tools[`${name}Sha256`]);
    // Reject FIFOs, devices and unbounded files before the upstream tool hashes
    // the executable with readFileSync(). npm .bin symlinks remain supported.
    const executable=statSync(tools[name],{throwIfNoEntry:false});
    if(!executable?.isFile()||executable.size<1||executable.size>MAX_TOOL_BYTES)
      fail('TOOL_TYPE_OR_SIZE');
  }
  return tools;
}
function snapshot(path,expected,directory,name,limit=MAX_ARTIFACT){
  if(expected!==undefined)digest(expected);
  if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))fail('ARTIFACT_PATH');
  const before=lstatSync(path,{throwIfNoEntry:false});
  if(!before?.isFile()||before.isSymbolicLink()||before.size<1||before.size>limit)fail('ARTIFACT_TYPE_OR_SIZE');
  let source,target;
  try{
    source=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    const opened=fstatSync(source);
    if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)fail('ARTIFACT_REPLACED');
    const copy=join(directory,name);
    target=openSync(copy,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
    const h=createHash('sha256'),chunk=Buffer.allocUnsafe(1024*1024);
    let total=0;
    for(;;){
      const n=readSync(source,chunk,0,chunk.length,null);
      if(n===0)break;
      total+=n;if(total>limit||total>opened.size)fail('ARTIFACT_CHANGED');
      h.update(chunk.subarray(0,n));
      let offset=0;
      while(offset<n){const wrote=writeSync(target,chunk,offset,n-offset);if(wrote<1)fail('ARTIFACT_WRITE');offset+=wrote;}
    }
    chunk.fill(0);
    const after=fstatSync(source);
    if(total!==opened.size||after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size)fail('ARTIFACT_CHANGED');
    const actualHash=h.digest('hex');
    if(expected!==undefined&&actualHash!==expected)fail('ARTIFACT_PIN_MISMATCH');
    fsyncSync(target);
    return copy;
  }catch(error){if(error?.message?.startsWith('NEMESIS_95_PINNED_'))throw error;fail('ARTIFACT_IO');}
  finally{if(source!==undefined)closeSync(source);if(target!==undefined)closeSync(target);}
}
function snapshotVerificationKey(path,expected,directory){
  // The trust anchor identifies canonical JSON, not the file's whitespace or key ordering.
  // Hash exactly the private snapshot passed to the verifier, never a mutable source path.
  const copy=snapshot(path,undefined,directory,'verification_key.json',MAX_VERIFICATION_KEY);
  let key;
  try{key=JSON.parse(readFileSync(copy,'utf8'));}
  catch{fail('VERIFICATION_KEY_JSON');}
  if(!key||typeof key!=='object'||Array.isArray(key))fail('VERIFICATION_KEY_JSON');
  if(createHash('sha256').update(canonicalSnarkJson(key)).digest('hex')!==expected)
    fail('VERIFICATION_KEY_PIN_MISMATCH');
  return copy;
}
export function runGaussNemesis95Pinned(input){
  shape(input,['action','program','witness','ptau','zkey','expectedPtauSha256','expectedZkeySha256',
    'trustedVerificationKeySha256','expectedProgramSha256','statement','proof','verificationKey',
    'expectedVerificationKeySha256','tools'],['action','program','expectedProgramSha256','tools']);
  const programPin=digest(input.expectedProgramSha256);
  if(compileExecutionCircuit(input.program).programSha256!==programPin)fail('PROGRAM_PIN_MISMATCH');
  if(input.action==='prove-pinned'){
    shape(input,['action','program','witness','ptau','zkey','expectedPtauSha256','expectedZkeySha256',
      'trustedVerificationKeySha256','expectedProgramSha256','tools'],
      ['action','program','witness','ptau','zkey','expectedPtauSha256','expectedZkeySha256',
      'trustedVerificationKeySha256','expectedProgramSha256','tools']);
    const ptauPin=digest(input.expectedPtauSha256),zkeyPin=digest(input.expectedZkeySha256);
    digest(input.trustedVerificationKeySha256);
    const tools=toolchain(input.tools,true);
    const dir=mkdtempSync(join(tmpdir(),'nemesis95-pinned-'));
    try{
      const ptau=snapshot(input.ptau,ptauPin,dir,'trusted.ptau');
      const zkey=snapshot(input.zkey,zkeyPin,dir,'trusted.zkey');
      const result=proveGroth16Execution({program:input.program,witness:input.witness,
        ptau,zkey,trustedVerificationKeySha256:input.trustedVerificationKeySha256,tools});
      return {...result,artifactPins:{ptauSha256:ptauPin,zkeySha256:zkeyPin},
        trustScope:'CALLER_SUPPLIED_PINS_NOT_PRODUCTION_CEREMONY_ATTESTATION'};
    }finally{rmSync(dir,{recursive:true,force:true});}
  }
  if(input.action==='verify-pinned'){
    shape(input,['action','program','statement','proof','verificationKey','expectedProgramSha256',
      'expectedVerificationKeySha256','tools'],['action','program','statement','proof',
      'verificationKey','expectedProgramSha256','expectedVerificationKeySha256','tools']);
    digest(input.expectedVerificationKeySha256);
    const tools=toolchain(input.tools,false);
    const dir=mkdtempSync(join(tmpdir(),'nemesis95-verification-'));
    try{
      const verificationKey=snapshotVerificationKey(input.verificationKey,input.expectedVerificationKeySha256,dir);
      return verifyGroth16Execution({program:input.program,statement:input.statement,proof:input.proof,
        verificationKey,expectedProgramSha256:programPin,
        expectedVerificationKeySha256:input.expectedVerificationKeySha256,tools});
    }finally{rmSync(dir,{recursive:true,force:true});}
  }
  fail('UNSUPPORTED_ACTION');
}
