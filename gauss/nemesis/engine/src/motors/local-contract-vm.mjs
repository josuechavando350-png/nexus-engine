import {createHash,createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';
import {object,array,id,integer,unique} from './shared.mjs';
const OPS=new Set(['EQ','NE','LT','LTE','GT','GTE']);
const compare=(a,b,op)=>op==='EQ'?a===b:op==='NE'?a!==b:op==='LT'?a<b:op==='LTE'?a<=b:op==='GT'?a>b:a>=b;
/** Canonical finite contract bytecode. No dynamic JS, IO, blockchain, or token transfers. */
export function compileLocalContract(spec){
 object(spec,'localContract',['name','registers','rules']);id(spec.name,'name');
 const registers=unique(array(spec.registers,'registers',1,32).map((r,i)=>id(r,`registers[${i}]`)),'registers');
 const rules=array(spec.rules,'rules',1,128).map((rule,i)=>{
  object(rule,`rule[${i}]`,['name','register','op','value','effect']);id(rule.name,'rule.name');
  if(!registers.includes(rule.register))throw new TypeError('unknown register');
  if(!OPS.has(rule.op))throw new TypeError('unknown op');
  integer(rule.value,'value',-1e9,1e9);
  object(rule.effect,'effect',['register','delta']);if(!registers.includes(rule.effect.register))throw new TypeError('unknown effect register');
  integer(rule.effect.delta,'delta',-1e9,1e9);
  return {name:id(rule.name,'rule.name'),test:[registers.indexOf(rule.register),rule.op,rule.value],effect:[registers.indexOf(rule.effect.register),rule.effect.delta]};
 });unique(rules.map(r=>r.name),'rule names');
 const program={format:'NEMESIS_LOCAL_VM_V1',name:spec.name,registers,rules};
 const hash=createHash('sha256').update(JSON.stringify(program)).digest('hex');
 return {program,hash};
}
export function executeLocalContract(compiled,initial,ruleName){
 object(compiled,'compiled',['program','hash']);const {program}=compiled;
 if(!program||program.format!=='NEMESIS_LOCAL_VM_V1'||compileLocalContract({name:program.name,registers:program.registers,rules:program.rules.map(r=>({name:r.name,register:program.registers[r.test[0]],op:r.test[1],value:r.test[2],effect:{register:program.registers[r.effect[0]],delta:r.effect[1]}}))}).hash!==compiled.hash)throw new TypeError('tampered bytecode');
 object(initial,'initial',program.registers);const state=program.registers.map(k=>integer(initial[k],`initial.${k}`,-1e9,1e9));
 id(ruleName,'ruleName');const rule=program.rules.find(r=>r.name===ruleName);if(!rule)throw new TypeError('unknown rule');
 if(!compare(state[rule.test[0]],rule.test[2],rule.test[1]))return {status:'REJECTED',state:Object.fromEntries(program.registers.map((k,i)=>[k,state[i]])),hash:compiled.hash};
 const i=rule.effect[0],next=state[i]+rule.effect[1];integer(next,'result',-1e9,1e9);state[i]=next;
 return {status:'APPLIED_IN_MEMORY',state:Object.fromEntries(program.registers.map((k,j)=>[k,state[j]])),hash:compiled.hash};
}
export function runLocalContract(input){object(input,'input',['contract','initial','rule']);return executeLocalContract(compileLocalContract(input.contract),input.initial,input.rule);}

/** Ed25519 attestation of the exact compiled artifact, not of input metrics or physical-world truth. */
const signedBytes=compiled=>{
 object(compiled,'compiled',['program','hash']);
 if(!compiled.program||compileLocalContract({name:compiled.program.name,registers:compiled.program.registers,rules:compiled.program.rules.map(r=>({name:r.name,register:compiled.program.registers[r.test[0]],op:r.test[1],value:r.test[2],effect:{register:compiled.program.registers[r.effect[0]],delta:r.effect[1]}}))}).hash!==compiled.hash)throw new TypeError('tampered bytecode');
 return Buffer.from(`NEMESIS_LOCAL_CONTRACT_V1\0${compiled.hash}`);
};
export function signLocalContract(compiled,privateKeyPem){const key=createPrivateKey(privateKeyPem);if(key.asymmetricKeyType!=='ed25519')throw new TypeError('Ed25519 key required');return sign(null,signedBytes(compiled),key).toString('base64');}
export function verifyLocalContractSignature(compiled,signature,publicKeyPem){
 if(typeof signature!=='string'||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(signature))return false;
 const bytes=Buffer.from(signature,'base64');if(bytes.length!==64||bytes.toString('base64')!==signature)return false;
 const key=createPublicKey(publicKeyPem);if(key.asymmetricKeyType!=='ed25519')throw new TypeError('Ed25519 key required');
 return verify(null,signedBytes(compiled),key,bytes);
}
