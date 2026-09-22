/**
 * GAUSS native entrypoint for Némesis #89. Only the byte-pinned executable
 * copied into a private temporary directory is launched: the source path
 * cannot be swapped between SHA-256 verification and process creation.
 * This protects executable identity, NOT trusted key provenance or TFHE security.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const DEFAULT_BINARY=fileURLToPath(new URL(`./native/fhe/target/release/nemesis-fhe${process.platform==='win32'?'.exe':''}`,import.meta.url));
const ops=Object.freeze({not:['a'],and:['a','b'],or:['a','b'],xor:['a','b'],nand:['a','b'],nor:['a','b'],xnor:['a','b'],mux:['s','a','b']});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const plain=(v,name)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype)throw new TypeError(`${name} must be a plain object`);};
function fields(v,name,allowed,required){plain(v,name);for(const key of Object.keys(v))if(!allowed.includes(key))throw new TypeError(`${name}: unsupported ${key}`);for(const key of required)if(!Object.hasOwn(v,key))throw new TypeError(`${name}: missing ${key}`);}
function wire(n,size,name){if(!Number.isSafeInteger(n)||n<0||n>=size)throw new RangeError(`${name}: invalid or forward wire`);return n;}
function gate(g,w){const a=w[g.a],b=w[g.b];switch(g.op){case'not':return !a;case'and':return a&&b;case'or':return a||b;case'xor':return a!==b;case'nand':return !(a&&b);case'nor':return !(a&&b);case'xnor':return a===b;case'mux':return w[g.s]?a:b;default:throw new TypeError('unsupported gate');}}
function checkedCircuit(input){
  if(!Array.isArray(input.inputs)||input.inputs.length<1||input.inputs.some(x=>typeof x!=='boolean'))throw new TypeError('inputs must contain 1..128 booleans');
  if(input.inputs.length>128)throw new RangeError('inputs must contain 1..128 booleans');
  if(!Array.isArray(input.gates)||input.gates.length>2048)throw new RangeError('gates must be an array <=2048');
  if(!Array.isArray(input.outputs)||input.outputs.length<1||input.outputs.length>128)throw new RangeError('outputs must contain 1..128 wires');
  const wires=[...input.inputs],encoded=[];
  for(const [i,g] of input.gates.entries()){
    plain(g,`gates[${i}]`);const args=typeof g.op==='string'&&Object.hasOwn(ops,g.op)?ops[g.op]:null;
    if(!args)throw new TypeError(`gates[${i}]: unsupported operation`);
    fields(g,`gates[${i}]`,['op',...args],['op',...args]);
    for(const k of args)wire(g[k],wires.length,`gates[${i}].${k}`);
    encoded.push([g.op,...args.map(k=>g[k])].join(':'));wires.push(gate(g,wires));
  }
  input.outputs.forEach((n,i)=>wire(n,wires.length,`outputs[${i}]`));
  return {args:['--circuit-stdin',encoded.join(';'),input.outputs.join(',')],stdin:input.inputs.map(x=>x?'1':'0').join(''),expected:input.outputs.map(n=>wires[n]),circuitSha256:hash(JSON.stringify({inputs:input.inputs.length,gates:input.gates,outputs:input.outputs}))};
}
function invoke(binary,pin,args,stdin){
  if(typeof binary!=='string'||!binary||/[\x00-\x1f]/.test(binary))throw new TypeError('invalid binary path');
  if(typeof pin!=='string'||!/^[a-f0-9]{64}$/.test(pin))throw new TypeError('expectedBinarySha256 must be an independently trusted sha256');
  let verifiedBytes;
  try{verifiedBytes=readFileSync(resolve(binary));}catch{throw new Error('NEMESIS_89_NATIVE_BINARY_MISSING');}
  if(verifiedBytes.byteLength>128*1024*1024)throw new Error('NEMESIS_89_NATIVE_BINARY_TOO_LARGE');
  const digest=hash(verifiedBytes);
  if(digest!==pin)throw new Error('NEMESIS_89_BINARY_PIN_MISMATCH');
  const dir=mkdtempSync(join(tmpdir(),'gauss-nemesis89-'));
  try{
    // The temp directory is private (0700). Never execute the mutable source path.
    const executable=join(dir,process.platform==='win32'?'nemesis-fhe.exe':'nemesis-fhe');
    writeFileSync(executable,verifiedBytes,{mode:0o700,flag:'wx'});
    const run=spawnSync(executable,args,{input:stdin,encoding:'utf8',timeout:240000,maxBuffer:1024*1024,shell:false,windowsHide:true});
    // Only a fixed, bounded OS error class or numeric status is exposed. Never log stderr, stdout, stdin or private witness bytes.
    if(run.error||run.status!==0){
      const code=run.error?.code;
      const failure=/^(?:EACCES|ENOENT|ENOEXEC|E2BIG|ETIMEDOUT|EPIPE|ENOMEM)$/.test(code??'')?code:
        Number.isInteger(run.status)&&run.status>=0&&run.status<=255?`EXIT_${run.status}`:'UNKNOWN';
      throw new Error(`NEMESIS_89_NATIVE_EXECUTION_FAILED_${failure}`);
    }
    try{return {data:JSON.parse(run.stdout),binarySha256:digest};}catch{throw new Error('NEMESIS_89_NATIVE_INVALID_JSON');}
  }finally{rmSync(dir,{recursive:true,force:true});}
}
/** Caller MUST obtain the SHA-256 pin from an independently trusted build. */
export function runGaussNemesis89(input){
  fields(input,'motor 89',['action','a','b','inputs','gates','outputs','binary','expectedBinarySha256'],['action','expectedBinarySha256']);
  const binary=input.binary??DEFAULT_BINARY;
  if(input.action==='native-add-u8'){
    for(const k of ['a','b'])if(!Number.isInteger(input[k])||input[k]<0||input[k]>255)throw new RangeError(`${k} must be unsigned byte`);
    if(['inputs','gates','outputs'].some(k=>Object.hasOwn(input,k)))throw new TypeError('unexpected circuit fields');
    const {data,binarySha256}=invoke(binary,input.expectedBinarySha256,['--add-stdin'],`${input.a} ${input.b}`);
    if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).sort().join(',')!=='backend,motor,sum,verified'||data.motor!==89||data.backend!=='TFHE_BOOLEAN'||data.verified!==true||data.sum!==input.a+input.b)
      throw new Error('NEMESIS_89_INDEPENDENT_SUM_MISMATCH');
    return {domain:'TFHE_BOOLEAN_NATIVE',motor:89,sum:data.sum,verified:true,binarySha256};
  }
  if(input.action==='native-circuit'){
    if(['a','b'].some(k=>Object.hasOwn(input,k)))throw new TypeError('unexpected adder fields');
    const circuit=checkedCircuit(input),{data,binarySha256}=invoke(binary,input.expectedBinarySha256,circuit.args,circuit.stdin);
    if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).sort().join(',')!=='backend,motor,outputs,verified'||data.motor!==89||data.backend!=='TFHE_BOOLEAN'||data.verified!==true||!Array.isArray(data.outputs)||data.outputs.length!==circuit.expected.length||data.outputs.some((x,i)=>typeof x!=='boolean'||x!==circuit.expected[i]))
      throw new Error('NEMESIS_89_INDEPENDENT_CIRCUIT_MISMATCH');
    return {domain:'TFHE_BOOLEAN_NATIVE',motor:89,outputs:data.outputs,verified:true,circuitSha256:circuit.circuitSha256,binarySha256};
  }
  throw new TypeError('motor 89 action must be native-add-u8 or native-circuit');
}
