/**
 * Némesis #95. Bounded arithmetic-circuit -> R1CS and Circom 2 compiler.
 * Real Groth16 is delegated to installed circom + snarkjs binaries. Never use
 * the legacy Schnorr proof as a Groth16 fallback. The verifier must pin the
 * expected program AND the trusted verifying-key digest out of band.
 */
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, isAbsolute} from 'node:path';

export const BN254_FR = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const sha = data => createHash('sha256').update(data).digest('hex');
const mod = n => ((n % BN254_FR) + BN254_FR) % BN254_FR;
const own = (v,k) => Object.hasOwn(v,k);
function fields(value, name, allowed, required=allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError(`${name} must be a plain object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${name}: unexpected key ${key}`);
  for (const key of required) if (!own(value,key)) throw new TypeError(`${name}: missing ${key}`);
  return value;
}
function scalar(value, label) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,76})$/.test(value))
    throw new TypeError(`${label}: expected canonical non-negative decimal string`);
  const v=BigInt(value);
  if (v >= BN254_FR) throw new RangeError(`${label}: outside BN254 scalar field`);
  return v;
}
function ref(value, label, witnessCount, nodeCount) {
  if (value && typeof value==='object' && !Array.isArray(value)) {
    fields(value,label,['const']);
    return {value:scalar(value.const,`${label}.const`), expr:value.const, r1cs:{'0':value.const}};
  }
  if (typeof value !== 'string') throw new TypeError(`${label}: expected wire name or {const:decimal}`);
  const match=/^(w|n)(0|[1-9][0-9]*)$/.exec(value);
  if (!match) throw new TypeError(`${label}: invalid wire name`);
  const index=Number(match[2]);
  if (!Number.isSafeInteger(index) || index >= (match[1]==='w'?witnessCount:nodeCount)) throw new TypeError(`${label}: unknown or forward wire`);
  return {index:match[1]==='w'?index+1:witnessCount+index+1,expr:match[1]==='w'?`w[${index}]`:`n${index}`};
}
const linear = (terms) => {
  const sum=new Map();
  for (const [v,c] of terms) {
    const key=v.index??0, coefficient=mod(c*(v.value??1n));
    sum.set(key,mod((sum.get(key)??0n)+coefficient));
  }
  return Object.fromEntries([...sum].filter(([,x])=>x!==0n).sort(([a],[b])=>a-b).map(([k,v])=>[k.toString(),v.toString()]));
};
const literal=v=>v.index===undefined?v.expr:v.expr;
export function canonicalSnarkJson(value){
  if(Array.isArray(value))return '['+value.map(canonicalSnarkJson).join(',')+']';
  if(value && typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalSnarkJson(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
const canonical = canonicalSnarkJson;
/** Compile user-specified, finite, acyclic field arithmetic to explicit R1CS and Circom. */
export function compileExecutionCircuit(program) {
  fields(program,'program',['witnessCount','nodes','output']);
  const witnessCount=program.witnessCount;
  if (!Number.isSafeInteger(witnessCount) || witnessCount<1 || witnessCount>64) throw new RangeError('witnessCount must be 1..64');
  if (!Array.isArray(program.nodes)||program.nodes.length>128) throw new RangeError('nodes must be array of at most 128');
  const nodes=program.nodes, constraints=[], body=[];
  const one={value:1n,expr:'1'};
  for (const [i,node] of nodes.entries()) {
    fields(node,`nodes[${i}]`,['id','op','left','right','cond','whenTrue','whenFalse'],['id','op']);
    if (node.id!==`n${i}`) throw new TypeError(`nodes[${i}].id must be n${i}`);
    if (!['add','sub','mul','select'].includes(node.op)) throw new TypeError('unknown op');
    const dest={index:witnessCount+i+1,expr:`n${i}`};

    if (node.op==='select') {
      if (own(node,'left')||own(node,'right')) throw new TypeError('select cannot contain left/right');
      for (const k of ['cond','whenTrue','whenFalse']) if (!own(node,k)) throw new TypeError(`missing ${k}`);
      const s=ref(node.cond,'cond',witnessCount,i), a=ref(node.whenTrue,'whenTrue',witnessCount,i), b=ref(node.whenFalse,'whenFalse',witnessCount,i);
      constraints.push({A:linear([[s,1n]]),B:linear([[s,1n],[one,-1n]]),C:{}}); // boolean constraint s(s-1)=0
      constraints.push({A:linear([[s,1n]]),B:linear([[a,1n],[b,-1n]]),C:linear([[dest,1n],[b,-1n]])});
      body.push(`    ${literal(s)} * (${literal(s)} - 1) === 0;`);
      body.push(`    n${i} <== ${literal(b)} + ${literal(s)} * (${literal(a)} - ${literal(b)});`);
    } else {
      if (own(node,'cond')||own(node,'whenTrue')||own(node,'whenFalse')) throw new TypeError('arithmetic op cannot contain select fields');
      if (!own(node,'left')||!own(node,'right')) throw new TypeError('arithmetic op requires left/right');
      const a=ref(node.left,'left',witnessCount,i),b=ref(node.right,'right',witnessCount,i);
      if(node.op==='mul') constraints.push({A:linear([[a,1n]]),B:linear([[b,1n]]),C:linear([[dest,1n]])});
      else constraints.push({A:linear([[a,1n],[b,node.op==='add'?1n:-1n]]),B:linear([[one,1n]]),C:linear([[dest,1n]])});
      body.push(`    n${i} <== ${literal(a)} ${node.op==='add'?'+':node.op==='sub'?'-':'*'} ${literal(b)};`);
    }
  }
  const output=ref(program.output,'output',witnessCount,nodes.length);
  if (output.index===undefined) throw new TypeError('output must reference a computed wire');
  const out={index:witnessCount+nodes.length+1,expr:'out'};
  constraints.push({A:linear([[output,1n],[out,-1n]]),B:linear([[one,1n]]),C:{}});
  body.push(`    out <== ${output.expr};`);
  const source=['pragma circom 2.1.6;','template Nemesis95() {',`    signal input w[${witnessCount}];`,'    signal output out;',...nodes.map((_,i)=>`    signal n${i};`),...body,'}','component main = Nemesis95();',''].join('\n');
  const programSha256=sha('NEMESIS-R1CS-BN254-V1\0'+canonical(program));
  return {programSha256, sourceSha256:sha(source), circomSource:source,
    r1cs:{field:BN254_FR.toString(),numberOfVariables:witnessCount+nodes.length+2,numberOfConstraints:constraints.length,constraints},
    witnessCount, nodeCount:nodes.length};
}
/** Private witness preflight. Returns no witness or private intermediates. */
export function checkExecutionWitness(program,witness) {
  const compiled=compileExecutionCircuit(program);
  if(!Array.isArray(witness)||witness.length!==program.witnessCount) throw new TypeError('witness length mismatch');
  const values=witness.map((v,i)=>scalar(v,`witness[${i}]`)), computed=[];
  const get=v=>v && typeof v==='object'?scalar(v.const,'const'):v[0]==='w'?values[Number(v.slice(1))]:computed[Number(v.slice(1))];
  for(const n of program.nodes){
    let value;
    if(n.op==='select') {const s=get(n.cond);if(s!==0n&&s!==1n)throw new TypeError('selector witness is not boolean');value=s===1n?get(n.whenTrue):get(n.whenFalse);}
    else {const a=get(n.left),b=get(n.right);value=mod(n.op==='add'?a+b:n.op==='sub'?a-b:a*b);}
    computed.push(value);
  }
  const result=mod(get(program.output));
  // Independent numerical R1CS check against compiled constraint matrices.
  const all=[1n,...values,...computed,result];
  const evalL=coeff=>mod(Object.entries(coeff).reduce((acc,[idx,c])=>acc+all[Number(idx)]*BigInt(c),0n));
  for(const [i,row] of compiled.r1cs.constraints.entries())
    if(mod(evalL(row.A)*evalL(row.B))!==evalL(row.C)) throw new Error(`R1CS witness fails constraint ${i}`);
  return {satisfied:true,output:result.toString(),programSha256:compiled.programSha256,constraintsChecked:compiled.r1cs.numberOfConstraints};
}
function run(executable,args,cwd,timeout=120000) {
  if(typeof executable!=='string'||!executable||/[\x00-\x1f]/.test(executable))throw new TypeError('invalid executable path');
  const res=spawnSync(executable,args,{cwd,encoding:'utf8',timeout,maxBuffer:4*1024*1024,shell:false,windowsHide:true});
  // External tools can echo private witnesses to stderr/stdout on failure.
  // Never embed their untrusted output or arguments in an exception.
  if(res.error||res.status!==0){
    const missing=res.error?.code==='ENOENT';
    const error=new Error(`SNARK external tool failed: ${missing?'ENOENT':res.error?.code??`exit ${res.status}`}`);
    error.code=missing?'SNARK_TOOL_MISSING':'SNARK_TOOL_FAILED';
    throw error;
  }
  return res.stdout;
}
function workspace(fn){const dir=mkdtempSync(join(tmpdir(),'nemesis95-'));try{return fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}}
function fileHash(path){return sha(readFileSync(path));}
function trustedPath(value,label){if(typeof value!=='string'||!value||!existsSync(value))throw new TypeError(`${label}: existing file required`);return resolve(value);}
function hash256(value,label){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new TypeError(`${label}: expected sha256 hex`);return value;}
/** snarkjs may print diagnostics before its result; only its FINAL whole line can confirm success.
 * Substrings such as "NOT OK!" and "not ZKey Ok!" must NEVER be accepted. */
function toolConfirmed(output, result) {
  if (typeof output !== 'string') return false;
  const lines=output.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const last=lines.at(-1);
  if (!last) return false;
  const expected=result==='groth16'?'OK!':'ZKey Ok!';
  const prefix='(?:\\[[A-Z]+\\]\\s*)?(?:snarkJS:\\s*)?';
  if (!new RegExp(`^${prefix}${expected.replace('!', '\\!')}$`,'i').test(last)) return false;
  return !lines.slice(0,-1).some(line=>/\b(?:error|failed|invalid|not\s+ok)\b/i.test(line));
}
/** Executable hashes are independently supplied; the executable does not vouch for its own pin. */
function pinnedExecutable(command,pin,label){
  if(pin===undefined)return command;
  const expected=hash256(pin,`${label}Sha256`);
  if(typeof command!=='string'||!isAbsolute(command)||!existsSync(command))
    throw new TypeError(`${label}: an existing absolute executable path is required when pinning`);
  if(fileHash(command)!==expected)throw new Error(`${label} executable failed trusted SHA-256 pin`);
  return command;
}
function toolchain(tools={}){
  fields(tools,'tools',['circom','snarkjs','circomSha256','snarkjsSha256'],[]);
  return {
    circom:pinnedExecutable(tools.circom??'circom',tools.circomSha256,'circom'),
    snarkjs:pinnedExecutable(tools.snarkjs??'snarkjs',tools.snarkjsSha256,'snarkjs')
  };
}
/** Trusted zkey and ptau must match the freshly generated R1CS; no insecure setup is synthesized. */
export function proveGroth16Execution(input){
  fields(input,'input',['action','program','witness','zkey','ptau','trustedVerificationKeySha256','tools'],['program','witness','zkey','ptau','trustedVerificationKeySha256']);
  const preflight=checkExecutionWitness(input.program,input.witness),compiled=compileExecutionCircuit(input.program);
  const zkey=trustedPath(input.zkey,'zkey'),ptau=trustedPath(input.ptau,'ptau'),pin=hash256(input.trustedVerificationKeySha256,'trustedVerificationKeySha256');
  const {circom,snarkjs}=toolchain(input.tools);
  return workspace(dir=>{
    const path=join(dir,'nemesis95.circom');writeFileSync(path,compiled.circomSource,{mode:0o600});
    run(circom,[path,'--r1cs','--wasm','-o',dir],dir);
    const r1cs=join(dir,'nemesis95.r1cs'),wasm=join(dir,'nemesis95_js','nemesis95.wasm');
    if(!existsSync(r1cs)||!existsSync(wasm))throw new Error('circom did not produce R1CS and witness WASM');
    const verifiedZkey=run(snarkjs,['zkey','verify',r1cs,ptau,zkey],dir);
    if(!toolConfirmed(verifiedZkey,'zkey'))throw new Error('zkey verification did not confirm circuit and Powers of Tau');
    const vkPath=join(dir,'verification_key.json');run(snarkjs,['zkey','export','verificationkey',zkey,vkPath],dir);
    const key=JSON.parse(readFileSync(vkPath,'utf8'));
    // Hash a canonical JSON serialization so the verifier can reproduce the pin.
    const vkSha256=sha(canonical(key));
    if(vkSha256!==pin)throw new Error('verification key does not match trusted pin');
    const inputPath=join(dir,'input.json');writeFileSync(inputPath,JSON.stringify({w:input.witness}),{mode:0o600});
    const proofPath=join(dir,'proof.json'),publicPath=join(dir,'public.json');
    run(snarkjs,['groth16','fullprove',inputPath,wasm,zkey,proofPath,publicPath],dir);
    const proof=JSON.parse(readFileSync(proofPath,'utf8')),publicSignals=JSON.parse(readFileSync(publicPath,'utf8'));
    if(!Array.isArray(publicSignals)||publicSignals.length!==1||publicSignals[0]!==preflight.output)throw new Error('prover public output mismatch');
    const verification=run(snarkjs,['groth16','verify',vkPath,publicPath,proofPath],dir);
    if(!toolConfirmed(verification,'groth16'))throw new Error('Groth16 proof failed independent snarkjs verification');
    return {domain:'GROTH16_BN254_EXECUTION',statement:{programSha256:compiled.programSha256,verificationKeySha256:pin,output:preflight.output},proof,
      circuit:{r1csSha256:fileHash(r1cs),sourceSha256:compiled.sourceSha256,constraints:compiled.r1cs.numberOfConstraints}};
  });
}
/** Caller pins both circuit program and verifying key, never trusts prover-supplied values. */
export function verifyGroth16Execution(input){
  fields(input,'input',['action','program','statement','proof','verificationKey','expectedProgramSha256','expectedVerificationKeySha256','tools'],['program','statement','proof','verificationKey','expectedProgramSha256','expectedVerificationKeySha256']);
  const compiled=compileExecutionCircuit(input.program),programPin=hash256(input.expectedProgramSha256,'expectedProgramSha256');
  const keyPin=hash256(input.expectedVerificationKeySha256,'expectedVerificationKeySha256');
  fields(input.statement,'statement',['programSha256','verificationKeySha256','output']);
  const output=scalar(input.statement.output,'statement.output').toString();
  if(compiled.programSha256!==programPin||input.statement.programSha256!==programPin||input.statement.verificationKeySha256!==keyPin)
    return {domain:'GROTH16_BN254_EXECUTION',verified:false,reason:'TRUSTED_PIN_MISMATCH'};
  const vk=trustedPath(input.verificationKey,'verificationKey'),key=JSON.parse(readFileSync(vk,'utf8'));
  if(sha(canonical(key))!==keyPin)return {domain:'GROTH16_BN254_EXECUTION',verified:false,reason:'VERIFICATION_KEY_MISMATCH'};
  if(!input.proof||typeof input.proof!=='object'||Array.isArray(input.proof))throw new TypeError('proof must be object');
  const {snarkjs}=toolchain(input.tools);
  return workspace(dir=>{
    const vkPath=join(dir,'verification_key.json'),proofPath=join(dir,'proof.json'),publicPath=join(dir,'public.json');
    writeFileSync(vkPath,JSON.stringify(key));writeFileSync(proofPath,JSON.stringify(input.proof));writeFileSync(publicPath,JSON.stringify([output]));
    try{const result=run(snarkjs,['groth16','verify',vkPath,publicPath,proofPath],dir);
      return {domain:'GROTH16_BN254_EXECUTION',verified:toolConfirmed(result,'groth16')};
    }catch(e){if(e.code==='SNARK_TOOL_MISSING')throw e;
      return {domain:'GROTH16_BN254_EXECUTION',verified:false,reason:'INVALID_PROOF'};}
  });
}
export function runExecutionSnark(input){
  fields(input,'motor 95 input',['action','program','witness','zkey','ptau','trustedVerificationKeySha256','tools','statement','proof','verificationKey','expectedProgramSha256','expectedVerificationKeySha256'],['action','program']);
  if(input.action==='compile')return compileExecutionCircuit(input.program);
  if(input.action==='check')return checkExecutionWitness(input.program,input.witness);
  if(input.action==='prove')return proveGroth16Execution(input);
  if(input.action==='verify')return verifyGroth16Execution(input);
  throw new TypeError('action must be compile, check, prove or verify');
}
