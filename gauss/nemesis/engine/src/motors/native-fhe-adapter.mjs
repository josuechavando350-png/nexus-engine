/** Némesis #89: fail-closed bridge to the real Rust TFHE Boolean evaluator. */
import {spawnSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const defaultBinary=fileURLToPath(new URL(`../../native/fhe/target/release/nemesis-fhe${process.platform==='win32'?'.exe':''}`,import.meta.url));
const MAX_CIRCUIT_INPUTS=128,MAX_CIRCUIT_GATES=2048,MAX_CIRCUIT_OUTPUTS=128;
const sha256=value=>createHash('sha256').update(value).digest('hex');
const own=(object,key)=>Object.hasOwn(object,key);
function plain(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)
    throw new TypeError(`${label} must be a plain object`);
}
function keys(value,label,allowed,required){
  plain(value,label);
  for(const key of Object.keys(value))if(!allowed.includes(key))throw new TypeError(`${label}: unexpected ${key}`);
  for(const key of required)if(!own(value,key))throw new TypeError(`${label}: missing ${key}`);
}
function wire(value,limit,label){
  if(!Number.isSafeInteger(value)||value<0||value>=limit)throw new RangeError(`${label}: invalid or forward wire`);
  return value;
}
const gateSpec={not:['a'],and:['a','b'],or:['a','b'],xor:['a','b'],nand:['a','b'],nor:['a','b'],xnor:['a','b'],mux:['s','a','b']};
function evaluateGate(gate,wires){
  const a=wires[gate.a], b=wires[gate.b];
  switch(gate.op){
    case 'not':return !a;
    case 'and':return a&&b;
    case 'or':return a||b;
    case 'xor':return a!==b;
    case 'nand':return !(a&&b);
    case 'nor':return !(a||b);
    case 'xnor':return a===b;
    case 'mux':return wires[gate.s]?a:b;
    default:throw new TypeError('unknown Boolean gate');
  }
}
/** Validate the complete DAG before ever starting the native process. */
export function compileNativeFheCircuit(input){
  keys(input,'native FHE input',['action','inputs','gates','outputs','binary','expectedBinarySha256'],['action','inputs','gates','outputs']);
  if(input.action!=='native-circuit')throw new TypeError('native-circuit action required');
  if(!Array.isArray(input.inputs)||input.inputs.length<1||input.inputs.length>MAX_CIRCUIT_INPUTS||input.inputs.some(x=>typeof x!=='boolean'))
    throw new TypeError(`inputs must contain 1..${MAX_CIRCUIT_INPUTS} booleans`);
  if(!Array.isArray(input.gates)||input.gates.length>MAX_CIRCUIT_GATES)throw new RangeError(`gates must contain at most ${MAX_CIRCUIT_GATES} entries`);
  if(!Array.isArray(input.outputs)||input.outputs.length<1||input.outputs.length>MAX_CIRCUIT_OUTPUTS)throw new RangeError(`outputs must contain 1..${MAX_CIRCUIT_OUTPUTS} wires`);
  const wires=[...input.inputs],encodedGates=[];
  for(const [i,gate] of input.gates.entries()){
    plain(gate,`gates[${i}]`);
    const args=typeof gate.op==='string'&&own(gateSpec,gate.op)?gateSpec[gate.op]:null;
    if(!args)throw new TypeError(`gates[${i}]: unsupported operation`);
    keys(gate,`gates[${i}]`,['op',...args],['op',...args]);
    for(const name of args)wire(gate[name],wires.length,`gates[${i}].${name}`);
    encodedGates.push([gate.op,...args.map(name=>gate[name])].join(':'));
    wires.push(evaluateGate(gate,wires));
  }
  input.outputs.forEach((w,i)=>wire(w,wires.length,`outputs[${i}]`));
  const expected=input.outputs.map(i=>wires[i]);
  // The input is private to the local invocation; no witness is included in the response.
  return {args:['--circuit-stdin',encodedGates.join(';'),input.outputs.join(',')],expected,
    circuitSha256:sha256(JSON.stringify({inputs:input.inputs.length,gates:input.gates,outputs:input.outputs}))};
}
function runBinary(binary,args,expectedBinarySha256,secretStdin){
  if(typeof binary!=='string'||!binary||/[\x00-\x1f]/.test(binary)||!existsSync(binary))throw new Error(`native TFHE executable unavailable: ${binary}`);
  const path=resolve(binary);
  const digest=sha256(readFileSync(path));
  if(expectedBinarySha256!==undefined){
    if(typeof expectedBinarySha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedBinarySha256))throw new TypeError('expectedBinarySha256 must be lowercase sha256');
    if(expectedBinarySha256!==digest)throw new Error('native TFHE executable failed trusted binary pin');
  }
  const result=spawnSync(path,args,{input:secretStdin,encoding:'utf8',timeout:240000,maxBuffer:1024*1024,shell:false,windowsHide:true});
  // Failed executable output is untrusted and could repeat the private stdin.
  if(result.error||result.status!==0)throw new Error(`native TFHE execution failed: ${result.error?.code??`exit ${result.status}`}`);
  let data;
  try{data=JSON.parse(result.stdout);}catch{throw new Error('native TFHE output is not JSON');}
  return {data,binarySha256:digest,binaryPinned:expectedBinarySha256!==undefined};
}
/** This check is local consistency, not a cryptographic proof of remote evaluation. */
export function runNativeFheCircuit(input){
  const compiled=compileNativeFheCircuit(input);
  const {data,binarySha256,binaryPinned}=runBinary(input.binary??defaultBinary,compiled.args,input.expectedBinarySha256,input.inputs.map(bit=>bit?'1':'0').join(''));
  if(!data||typeof data!=='object'||Array.isArray(data)||
     Object.keys(data).sort().join(',')!=='backend,motor,outputs,verified'||
     data.motor!==89||data.backend!=='TFHE_BOOLEAN'||data.verified!==true||
     !Array.isArray(data.outputs)||data.outputs.length!==compiled.expected.length||
     data.outputs.some((bit,i)=>typeof bit!=='boolean'||bit!==compiled.expected[i]))
    throw new Error('native TFHE output failed independent circuit consistency check');
  return {domain:'TFHE_BOOLEAN_NATIVE',motor:89,backend:'TFHE_BOOLEAN',outputs:data.outputs,
    verified:true,binaryPinned,circuitSha256:compiled.circuitSha256,binarySha256};
}
export function runNativeFheAdder(input){
  keys(input,'native FHE input',['action','a','b','binary','expectedBinarySha256'],['action','a','b']);
  if(input.action!=='native-add-u8')throw new TypeError('native-add-u8 action required');
  for(const key of ['a','b'])if(!Number.isInteger(input[key])||input[key]<0||input[key]>255)throw new RangeError(`${key} must be an unsigned byte`);
  const {data,binarySha256,binaryPinned}=runBinary(input.binary??defaultBinary,['--add-stdin'],input.expectedBinarySha256,`${input.a} ${input.b}`);
  if(!data||typeof data!=='object'||Array.isArray(data)||
     Object.keys(data).sort().join(',')!=='backend,motor,sum,verified'||
     data.motor!==89||data.backend!=='TFHE_BOOLEAN'||data.verified!==true||
     !Number.isInteger(data.sum)||data.sum!==input.a+input.b)
    throw new Error('native TFHE output failed independent addition consistency check');
  return {domain:'TFHE_BOOLEAN_NATIVE',motor:89,backend:'TFHE_BOOLEAN',sum:data.sum,verified:true,binaryPinned,binarySha256};
}
