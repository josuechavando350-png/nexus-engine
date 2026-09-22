#!/usr/bin/env node
/** Real end-to-end native integration test: without installed toolchain/ceremony, exit nonzero. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {compileExecutionCircuit,proveGroth16Execution,verifyGroth16Execution,canonicalSnarkJson} from '../src/motors/execution-snark.mjs';
const [ptau,zkey,verificationKey,trustedKeySha256]=process.argv.slice(2);
if(!ptau||!zkey||!verificationKey||!trustedKeySha256||process.argv.length!==6||!/^[a-f0-9]{64}$/.test(trustedKeySha256)){console.error('Usage: node scripts/verify-snark-95.mjs <pot_final.ptau> <circuit_final.zkey> <verification_key.json> <OUT_OF_BAND_TRUSTED_KEY_SHA256>');process.exit(2);}
const report={motor:95,backend:'GROTH16_BN254',startedAt:new Date().toISOString(),status:'NOT_RUN',tests:{}};
try{
 const program=JSON.parse(readFileSync(new URL('../examples/v14/motor-95-program.json',import.meta.url),'utf8'));
 const vk=JSON.parse(readFileSync(verificationKey,'utf8'));
 const keySha256=createHash('sha256').update(canonicalSnarkJson(vk)).digest('hex');
 if(keySha256!==trustedKeySha256)throw new Error('verification key differs from independently trusted pin');
 const programSha256=compileExecutionCircuit(program).programSha256;
 const proof=proveGroth16Execution({program,witness:['7','11','1'],ptau:resolve(ptau),zkey:resolve(zkey),trustedVerificationKeySha256:trustedKeySha256});
 const original={program,statement:proof.statement,proof:proof.proof,verificationKey:resolve(verificationKey),expectedProgramSha256:programSha256,expectedVerificationKeySha256:trustedKeySha256};
 report.tests.valid=verifyGroth16Execution(original).verified===true;
 report.tests.alteredOutput=verifyGroth16Execution({...original,statement:{...proof.statement,output:'75'}}).verified===false;
 report.tests.alteredProgram=verifyGroth16Execution({...original,program:{...program,output:'w0'}}).verified===false;
 report.tests.alteredKeyPin=verifyGroth16Execution({...original,expectedVerificationKeySha256:'0'.repeat(64)}).verified===false;
 report.tests.alteredProof=verifyGroth16Execution({...original,proof:{...proof.proof,pi_a:['0',...proof.proof.pi_a.slice(1)]}}).verified===false;
 report.programSha256=programSha256;report.verificationKeySha256=keySha256;report.circuit=proof.circuit;
 report.status=Object.values(report.tests).every(Boolean)?'PASS':'FAILED';
}catch(error){report.status='BLOCKED_OR_FAILED';report.error=error.message;}
report.finishedAt=new Date().toISOString();
mkdirSync(new URL('../evidence/',import.meta.url),{recursive:true});
writeFileSync(new URL('../evidence/native-snark-95-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
process.exitCode=report.status==='PASS'?0:1;
