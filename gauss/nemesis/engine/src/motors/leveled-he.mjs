import {randomBytes} from 'node:crypto';
// DGHV-style integer somewhat homomorphic encryption (symmetric, no bootstrapping).
// Research only: parameters have NOT been audited, no confidentiality guarantee.
const rand = n => BigInt('0x'+randomBytes(n).toString('hex'));
const MAX_BOUND=1n<<192n;
const bit = (x,name) => {if(x!==0&&x!==1)throw new TypeError(`${name} must be a bit`);return BigInt(x);};
function canonical(x,name){if(typeof x!=='string'||!/^(0|[1-9][0-9]*)$/.test(x))throw new TypeError(`${name} must be canonical unsigned decimal string`);return BigInt(x);}
function ciphertext(x){if(x===null||typeof x!=='object'||Array.isArray(x)||Object.keys(x).sort().join(',')!=='bound,ciphertext')throw new TypeError('invalid ciphertext');const c=BigInt(x.ciphertext);const bound=canonical(x.bound,'bound');if(bound>=MAX_BOUND)throw new RangeError('noise bound exhausted; bootstrapping unavailable');return {c,bound};}
function pack(c,bound){if(bound>=MAX_BOUND)throw new RangeError('noise bound exhausted; bootstrapping unavailable');return {ciphertext:c.toString(),bound:bound.toString()};}
export function generateToyHeKey(){const p=(rand(48)|(1n<<383n)|1n);return {secret:p.toString(),scheme:'DGHV_RESEARCH_SYMMETRIC_SOMEWHAT_HE'};}
export function encryptToyBit(key,value){const p=canonical(key?.secret,'secret');if(p<(1n<<383n)||!(p&1n))throw new TypeError('unsupported research key');const m=bit(value,'value');const q=rand(16)+1n;const r=rand(1)%17n-8n;return pack(p*q+2n*r+m,17n);}
export function evaluateToyGate(op,left,right){const l=ciphertext(left);let v,b;if(op==='NOT'){v=1n-l.c;b=1n+l.bound;}else{const r=ciphertext(right);switch(op){case'XOR':v=l.c+r.c;b=l.bound+r.bound;break;case'AND':v=l.c*r.c;b=l.bound*r.bound;break;case'NAND':v=1n-l.c*r.c;b=1n+l.bound*r.bound;break;case'OR':v=l.c+r.c-l.c*r.c;b=l.bound+r.bound+l.bound*r.bound;break;default:throw new TypeError('unsupported gate');}}return pack(v,b);}
export function decryptToyBit(key,encrypted){const p=canonical(key?.secret,'secret');if(p<(1n<<383n)||!(p&1n))throw new TypeError('unsupported research key');const {c,bound}=ciphertext(encrypted);if(bound>=p/2n)throw new RangeError('noise exceeds decryption capacity');let residue=((c%p)+p)%p;if(residue>p/2n)residue-=p;return Number(((residue%2n)+2n)%2n);}
/** Computes actual ciphertext-only gates, then decrypts with a separate local key for the demo. */
export function runLeveledHeCircuit(input){
 if(input===null||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['bits','gates','output'].includes(k)))throw new TypeError('invalid circuit');
 if(!Array.isArray(input.bits)||input.bits.length<1||input.bits.length>8||!Array.isArray(input.gates)||input.gates.length>16)throw new TypeError('invalid circuit size');
 const key=generateToyHeKey(),register=new Map();
 input.bits.forEach((v,i)=>register.set(`in${i}`,encryptToyBit(key,v)));
 input.gates.forEach((gate,i)=>{
  if(!gate||typeof gate!=='object'||Object.keys(gate).some(k=>!['id','op','left','right'].includes(k)))throw new TypeError(`invalid gate ${i}`);
  if(typeof gate.id!=='string'||!/^[a-z][a-z0-9_]{0,31}$/.test(gate.id)||register.has(gate.id))throw new TypeError(`invalid gate id ${i}`);
  if(!register.has(gate.left)||gate.op!=='NOT'&&!register.has(gate.right))throw new TypeError('missing or future circuit dependency');
  register.set(gate.id,evaluateToyGate(gate.op,register.get(gate.left),register.get(gate.right)));
 });
 if(!register.has(input.output))throw new TypeError('missing output');
 const result=register.get(input.output);
 return {domain:'SYMMETRIC_SOMEWHAT_HOMOMORPHIC_BITS_NOT_FHE',result:decryptToyBit(key,result),ciphertext:result.ciphertext,noiseBound:result.bound,gateCount:input.gates.length,warning:'No bootstrapping, no public-key encryption, no audited security. Key is held only by this local demo and not exposed to the evaluator.'};
}
