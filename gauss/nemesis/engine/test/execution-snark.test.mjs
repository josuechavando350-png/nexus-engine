import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {compileExecutionCircuit,checkExecutionWitness,runMotor,verifyGroth16Execution,proveGroth16Execution} from '../src/index.mjs';

const P=21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const prg={witnessCount:3,nodes:[
 {id:'n0',op:'mul',left:'w0',right:'w1'},
 {id:'n1',op:'sub',left:'n0',right:{const:'3'}},
 {id:'n2',op:'add',left:'n1',right:'w2'},
 {id:'n3',op:'select',cond:'w2',whenTrue:'n1',whenFalse:'w0'}],output:'n3'};
const mod=n=>(n%P+P)%P;
const independent=(constraints,assignment)=>constraints.every(row=>{
 const value=coeff=>mod(Object.entries(coeff).reduce((v,[index,c])=>v+assignment[Number(index)]*BigInt(c),0n));
 return mod(value(row.A)*value(row.B))===value(row.C);
});
test('95 compiler produces deterministic nonempty R1CS, handles all arithmetic ops and boolean selector',()=>{
 const built=compileExecutionCircuit(prg);assert.equal(built.r1cs.numberOfConstraints,6);
 assert.equal(built.r1cs.numberOfVariables,9);
 assert.deepEqual(compileExecutionCircuit(structuredClone(prg)),built);
 assert.equal(compileExecutionCircuit({output:prg.output,nodes:prg.nodes.map(n=>Object.fromEntries(Object.entries(n).reverse())),witnessCount:prg.witnessCount}).programSha256,built.programSha256);
 assert.match(built.circomSource,/n3 <== w\[0\] \+ w\[2\] \* \(n1 - w\[0\]\)/);
 assert.match(built.circomSource,/w\[2\] \* \(w\[2\] - 1\) === 0/);
 assert.equal(checkExecutionWitness(prg,['7','11','1']).output,'74');
 assert.equal(checkExecutionWitness(prg,['7','11','0']).output,'7');
 assert.equal(runMotor('95',{action:'check',program:prg,witness:['7','11','1']}).satisfied,true);
 assert.throws(()=>checkExecutionWitness(prg,['7','11','2']),/not boolean/);
});
test('95 R1CS equations hold for valid assignments and reject altered result or selector',()=>{
 const c=compileExecutionCircuit(prg).r1cs.constraints;
 for(let a=0n;a<9n;a++)for(let b=0n;b<9n;b++)for(const s of [0n,1n]){
  const n0=mod(a*b),n1=mod(n0-3n),n2=mod(n1+s),n3=s?n1:a;
  const assignment=[1n,a,b,s,n0,n1,n2,n3,n3];
  assert.equal(independent(c,assignment),true);
  assert.equal(independent(c,[...assignment.slice(0,8),mod(n3+1n)]),false);
  assert.equal(independent(c,[...assignment.slice(0,3),2n,...assignment.slice(4)]),false);
 }
});
test('95 compiler rejects unsafe input, forward wires, nonfield decimals and malformed operations',()=>{
 const reject = (p,regex)=>assert.throws(()=>compileExecutionCircuit(p),regex);
 reject({...prg,nodes:[{id:'n0',op:'mul',left:'n0',right:'w0'}]},/forward/);
 reject({...prg,witnessCount:0},/witnessCount/);
 reject({...prg,output:{const:'0'}},/output must reference/);
 reject({...prg,nodes:[{id:'n0',op:'mul',left:{const:P.toString()},right:'w0'}]},/outside BN254/);
 reject({...prg,nodes:[{id:'n0',op:'add',left:{const:'-1'},right:'w0'}]},/canonical/);
 reject({...prg,nodes:[{id:'n0',op:'noop',left:'w0',right:'w1'}]},/unknown op/);
 reject({...prg,nodes:[{id:'n0',op:'select',cond:'w0',whenTrue:'w1',whenFalse:'w2',right:'w0'}]},/left\/right/);
 assert.throws(()=>checkExecutionWitness(prg,['0','1']),/length/);
 assert.throws(()=>checkExecutionWitness(prg,['0','1',1]),/decimal/);
});
test('95 verifier rejects mismatched program/key pins before calling any prover',()=>{
 const compiled=compileExecutionCircuit(prg);
 const input={program:prg,statement:{programSha256:compiled.programSha256,verificationKeySha256:'a'.repeat(64),output:'74'},proof:{foo:'bar'},verificationKey:'/not/present',expectedProgramSha256:'b'.repeat(64),expectedVerificationKeySha256:'a'.repeat(64)};
 assert.deepEqual(verifyGroth16Execution(input),{domain:'GROTH16_BN254_EXECUTION',verified:false,reason:'TRUSTED_PIN_MISMATCH'});
 assert.deepEqual(runMotor('95',{action:'verify',...input}),{domain:'GROTH16_BN254_EXECUTION',verified:false,reason:'TRUSTED_PIN_MISMATCH'});
 assert.throws(()=>proveGroth16Execution({program:prg,witness:['7','11','2'],zkey:'/no',ptau:'/no',trustedVerificationKeySha256:'a'.repeat(64)}),/not boolean/);
 assert.throws(()=>proveGroth16Execution({program:prg,witness:['7','11','1'],zkey:'/no',ptau:'/no',trustedVerificationKeySha256:'a'.repeat(64)}),/zkey: existing file required/);
});
test('95 CLI compile succeeds; false Groth16 verification exits nonzero without exposing private witness',()=>{
 const d=mkdtempSync(join(tmpdir(),'nemesis95-test-'));
 try{
  const path=join(d,'input.json');writeFileSync(path,JSON.stringify({action:'compile',program:prg}));
  const a=spawnSync(process.execPath,['cli.mjs','motor',path,'95'],{cwd:new URL('../',import.meta.url),encoding:'utf8',timeout:20000});
  assert.equal(a.status,0,a.stderr);assert.equal(JSON.parse(a.stdout).r1cs.numberOfConstraints,6);
  const programSha256=compileExecutionCircuit(prg).programSha256;
  writeFileSync(path,JSON.stringify({action:'verify',program:prg,statement:{programSha256,verificationKeySha256:'a'.repeat(64),output:'74'},proof:{},verificationKey:'/no',expectedProgramSha256:'b'.repeat(64),expectedVerificationKeySha256:'a'.repeat(64)}));
  const b=spawnSync(process.execPath,['cli.mjs','motor',path,'95'],{cwd:new URL('../',import.meta.url),encoding:'utf8',timeout:20000});
  assert.equal(b.status,1,b.stderr);assert.equal(JSON.parse(b.stdout).verified,false);
 }finally{rmSync(d,{recursive:true,force:true});}
});
test('95 real Groth16 requirement is fail-closed when binary or setup is unavailable',async()=>{
 const d=mkdtempSync(join(tmpdir(),'nemesis95-backend-'));
 try{
  const zkey=join(d,'zkey'),ptau=join(d,'ptau');writeFileSync(zkey,'missing real setup');writeFileSync(ptau,'missing powers of tau');
  const input={action:'prove',program:prg,witness:['7','11','1'],zkey,ptau,trustedVerificationKeySha256:'a'.repeat(64),tools:{circom:join(d,'missing-circom'),snarkjs:join(d,'missing-snarkjs')}};
  assert.throws(()=>runMotor('95',input),/ENOENT|failed/);
  const blocked=await(await import('../src/index.mjs')).runMotorPipeline({tasks:[{id:'proof',motor:'95',input}]});
  assert.equal(blocked.status,'BLOCKED');assert.equal(blocked.tasks.length,0);
 }finally{rmSync(d,{recursive:true,force:true});}
});

test('95: deterministic property tests compare compiler witness against an independent field oracle',async()=>{
 let seed=0x9e3779b9;
 const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
 const q=21888242871839275222246405745257275088696311157297823662689037894645226208583n;
 const rem=x=>(x%q+q)%q;
 const {compileExecutionCircuit,checkExecutionWitness}=await import('../src/motors/execution-snark.mjs');
 for(let caseIndex=0;caseIndex<120;caseIndex++){
  const witness=[String(random()%2),String(random()),String(random()),String(random())];
  const values=witness.map(BigInt),nodes=[];
  const available=['w0','w1','w2','w3'];
  const choice=()=>random()%5===0?{const:String(random()%100)}:available[random()%available.length];
  const get=ref=>typeof ref==='string'?values[available.indexOf(ref)]:BigInt(ref.const);
  for(let i=0;i<20;i++){
   const op=['add','sub','mul','select'][random()%4];
   let node,value;
   if(op==='select'){
    const cond='w0',whenTrue=choice(),whenFalse=choice();
    node={id:`n${i}`,op,cond,whenTrue,whenFalse};
    value=get(cond)?get(whenTrue):get(whenFalse);
   }else{
    const left=choice(),right=choice();node={id:`n${i}`,op,left,right};
    value=rem(op==='add'?get(left)+get(right):op==='sub'?get(left)-get(right):get(left)*get(right));
   }
   nodes.push(node);available.push(`n${i}`);values.push(value);
  }
  const program={witnessCount:witness.length,nodes,output:'n19'};
  const result=checkExecutionWitness(program,witness);
  assert.equal(result.output,values.at(-1).toString());
  assert.equal(result.constraintsChecked,1+nodes.length+nodes.filter(n=>n.op==='select').length);
  assert.equal(result.programSha256,compileExecutionCircuit(program).programSha256);
 }
});

test('95: integration verifier requires a verification-key hash established out of band',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nemesis95-pin-'));
 try{
  const key=join(dir,'vk.json');writeFileSync(key,'{}');
  const script=new URL('../scripts/verify-snark-95.mjs',import.meta.url);
  const missing=spawnSync(process.execPath,[script.pathname,'/ptau','/zkey',key],{encoding:'utf8'});
  assert.equal(missing.status,2);assert.match(missing.stderr,/OUT_OF_BAND_TRUSTED_KEY_SHA256/);
  const wrong=spawnSync(process.execPath,[script.pathname,'/ptau','/zkey',key,'0'.repeat(64)],{encoding:'utf8'});
  assert.equal(wrong.status,1);
  assert.match(wrong.stdout,/verification key differs from independently trusted pin/);
  assert.doesNotMatch(wrong.stdout,/"witness"/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
