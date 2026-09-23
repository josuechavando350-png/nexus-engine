import {randomBytes,createHash,getDiffieHellman} from 'node:crypto';
import {object,modPow,mod} from './finite-tools.mjs';
// Schnorr/Fiat-Shamir proof for an explicitly known discrete-log relation in the
// prime-order QR subgroup of RFC 3526 MODP group 14; not a general execution proof.
const p=BigInt('0x'+getDiffieHellman('modp14').getPrime('hex'));
const q=(p-1n)/2n, g=4n;
if(modPow(g,q,p)!==1n||g===1n)throw new Error('unavailable known MODP14 subgroup');
function group(value){object(value,'group',['id']);if(value.id!=='MODP14-QR')throw new TypeError('unsupported group; only known MODP14-QR is permitted');}
function scalar(value,label,upper=q){if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value))throw new TypeError(`${label} must be canonical decimal integer`);const x=BigInt(value);if(x<0n||x>=upper)throw new TypeError(`${label} out of subgroup range`);return x;}
function challenge(y,t,context){const bytes=createHash('sha256').update('NEMESIS-SCHNORR-MODP14-QR-V1\0').update(y.toString(16)).update('\0').update(t.toString(16)).update('\0').update(context,'utf8').digest('hex');return BigInt('0x'+bytes)%q;}
function nonce(){const size=Math.ceil(q.toString(2).length/8);for(;;){const k=BigInt('0x'+randomBytes(size).toString('hex'));if(k>0n&&k<q)return k;}}
export function proveDiscreteLogRelation(input){object(input,'proof',['group','witness','context']);group(input.group);const x=scalar(input.witness,'witness');if(typeof input.context!=='string'||input.context.length<1||input.context.length>1024)throw new TypeError('invalid context');
 const k=nonce(),y=modPow(g,x,p),t=modPow(g,k,p),c=challenge(y,t,input.context),z=mod(k+c*x,q);
 return {statement:{group:{id:'MODP14-QR'},y:y.toString(),context:input.context},proof:{t:t.toString(),z:z.toString()}};
}
export function verifyDiscreteLogRelation(input){object(input,'verification',['statement','proof']);const s=object(input.statement,'statement',['group','y','context']),a=object(input.proof,'proof',['t','z']);group(s.group);
 if(typeof s.context!=='string'||s.context.length<1||s.context.length>1024)throw new TypeError('invalid context');const y=scalar(s.y,'y',p),t=scalar(a.t,'t',p),z=scalar(a.z,'z');
 if(y===0n||t===0n||modPow(y,q,p)!==1n||modPow(t,q,p)!==1n)return {verified:false};const c=challenge(y,t,s.context);return {verified:modPow(g,z,p)===mod(t*modPow(y,c,p),p)};
}
export function runZkRelation(input){return {...verifyDiscreteLogRelation(input),domain:'SCHNORR_MODP14_RELATION_ONLY'};}
