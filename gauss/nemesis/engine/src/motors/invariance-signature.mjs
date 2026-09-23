import {createHash,sign,verify,createPrivateKey,createPublicKey} from 'node:crypto';
import {object,array,id,canon,integer} from './finite-tools.mjs';
function digest(x){return createHash('sha256').update(canon(x)).digest('hex');}
export function certifyStateInvariant(input,privateKey){
 object(input,'invariance',['before','after','invariantKeys','context','epoch'],['before','after','invariantKeys','context','epoch']);const b=object(input.before,'before',Object.keys(input.before)),a=object(input.after,'after',Object.keys(input.after));
 const keys=array(input.invariantKeys,'invariantKeys',1,128).map((k,i)=>id(k,`key[${i}]`));if(new Set(keys).size!==keys.length)throw new TypeError('duplicate keys');for(const k of keys)if(!Object.hasOwn(b,k)||!Object.hasOwn(a,k)||digest(b[k])!==digest(a[k]))throw new TypeError(`invariant changed: ${k}`);
 id(input.context,'context');integer(input.epoch,'epoch',0,Number.MAX_SAFE_INTEGER);const statement={beforeHash:digest(b),afterHash:digest(a),invariantKeys:keys,context:input.context,epoch:input.epoch};
 const signature=sign(null,Buffer.from(canon(statement)),createPrivateKey(privateKey)).toString('base64');return {statement,signature,algorithm:'Ed25519'};
}
export function verifyStateInvariantSignature(input,publicKey,before,after,expectedContext,expectedEpoch){
 object(input,'certificate',['statement','signature','algorithm']);const s=object(input.statement,'statement',['beforeHash','afterHash','invariantKeys','context','epoch']);
 if(input.algorithm!=='Ed25519'||s.context!==expectedContext||s.epoch!==expectedEpoch||!Array.isArray(s.invariantKeys)||new Set(s.invariantKeys).size!==s.invariantKeys.length||s.invariantKeys.some(k=>!Object.hasOwn(before,k)||!Object.hasOwn(after,k)||digest(before[k])!==digest(after[k]))||digest(before)!==s.beforeHash||digest(after)!==s.afterHash)return {verified:false};
 return {verified:verify(null,Buffer.from(canon(s)),createPublicKey(publicKey),Buffer.from(input.signature,'base64'))};
}
export function runInvarianceVerification(input){object(input,'invariance verification',['certificate','publicKey','before','after','context','epoch']);return {...verifyStateInvariantSignature(input.certificate,input.publicKey,input.before,input.after,input.context,input.epoch),domain:'SIGNED_STATE_INVARIANT_CLAIM'};}
