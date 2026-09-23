import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { object, array, id, integer, unique } from './shared.mjs';

const canonical=v=>{
  if(v===null||typeof v==='boolean'||typeof v==='string'||(typeof v==='number'&&Number.isSafeInteger(v)))return JSON.stringify(v);
  if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;
  if(v&&typeof v==='object'&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null))
    return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  throw new TypeError('noncanonical contract value');
};
const digest=value=>createHash('sha256').update('NEMESIS_CERTAINTY_CONTRACT_V1\0').update(canonical(value)).digest('hex');
const shaPattern=/^[0-9a-f]{64}$/;
/** Compile explicit deterministic numeric requirements; not a proof about the observed world. */
export function compileCertaintyContract(contract) {
  object(contract,'contract',['id','artifactSha256','predicates']);
  id(contract.id,'contract.id');
  if(typeof contract.artifactSha256!=='string'||!shaPattern.test(contract.artifactSha256))throw new TypeError('artifactSha256 must be lowercase SHA-256');
  const predicates=array(contract.predicates,'predicates',1,64);
  unique(predicates.map((p,i)=>{
    object(p,`predicates[${i}]`,['metric','op','value']);
    id(p.metric,`predicates[${i}].metric`);
    if(!['EQ','LTE','GTE'].includes(p.op))throw new TypeError('unknown operator');
    integer(p.value,`predicates[${i}].value`,-1000000000,1000000000);
    return p.metric;
  }),'predicate metrics');
  const manifest={version:1,id:contract.id,artifactSha256:contract.artifactSha256,
    predicates:predicates.map(p=>({metric:p.metric,op:p.op,value:p.value})).sort((a,b)=>a.metric.localeCompare(b.metric))};
  return {engine:'NEMESIS_CERTAINTY_CONTRACT_V1',manifest,contractHash:digest(manifest)};
}
/** Evaluate signed-off measurements supplied by caller; signatures don't authenticate a sensor. */
export function evaluateCertaintyContract(compiled,observations) {
  object(compiled,'compiled',['engine','manifest','contractHash']);
  if(compiled.engine!=='NEMESIS_CERTAINTY_CONTRACT_V1'||compileCertaintyContract({id:compiled.manifest?.id,artifactSha256:compiled.manifest?.artifactSha256,predicates:compiled.manifest?.predicates}).contractHash!==compiled.contractHash)throw new TypeError('compiled contract mismatch');
  const rows=array(observations,'observations',0,128);
  unique(rows.map((v,i)=>{
    object(v,`observations[${i}]`,['metric','value']);id(v.metric,`observations[${i}].metric`);
    integer(v.value,`observations[${i}].value`,-1000000000,1000000000);return v.metric;
  }),'observed metrics');
  const byMetric=new Map(rows.map(v=>[v.metric,v.value]));
  const results=compiled.manifest.predicates.map(p=>{
    const observed=byMetric.get(p.metric);
    const pass=observed!==undefined && (p.op==='EQ'?observed===p.value:p.op==='LTE'?observed<=p.value:observed>=p.value);
    return {metric:p.metric,op:p.op,expected:p.value,observed:observed??null,pass};
  });
  const report={version:1,contractHash:compiled.contractHash,artifactSha256:compiled.manifest.artifactSha256,
    observations:rows.map(v=>({metric:v.metric,value:v.value})).sort((a,b)=>a.metric.localeCompare(b.metric)),checks:results,status:results.every(p=>p.pass)?'PASS':'FAIL'};
  return {engine:'NEMESIS_CERTAINTY_CONTRACT_V1',...report,reportHash:digest(report),
    note:'Measurements and artifact hash are assertions supplied by caller; this does not independently observe them.'};
}
function signedPayload(report){
  object(report,'report',['engine','version','contractHash','artifactSha256','observations','checks','status','reportHash','note']);
  const {engine,reportHash,note,...body}=report;
  if(engine!=='NEMESIS_CERTAINTY_CONTRACT_V1'||digest(body)!==reportHash)throw new TypeError('report integrity mismatch');
  return Buffer.from(`NEMESIS_CERTAINTY_ATTESTATION_V1\0${canonical(body)}`,'utf8');
}
export function signPassingContract(report,privateKeyPem){
  if(report.status!=='PASS')throw new TypeError('refusing to sign failing contract');
  const key=createPrivateKey(privateKeyPem);
  if(key.asymmetricKeyType!=='ed25519')throw new TypeError('only Ed25519 keys supported');
  const signature=sign(null,signedPayload(report),key).toString('base64');
  return {algorithm:'Ed25519',reportHash:report.reportHash,signature};
}
export function verifyContractAttestation(compiled,observations,attestation,publicKeyPem){
  object(attestation,'attestation',['algorithm','reportHash','signature']);
  if(attestation.algorithm!=='Ed25519'||!shaPattern.test(attestation.reportHash))return false;
  if(typeof attestation.signature!=='string'||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attestation.signature))return false;
  const bytes=Buffer.from(attestation.signature,'base64');if(bytes.length!==64||bytes.toString('base64')!==attestation.signature)return false;
  const report=evaluateCertaintyContract(compiled,observations);
  if(report.status!=='PASS'||report.reportHash!==attestation.reportHash)return false;
  const key=createPublicKey(publicKeyPem);if(key.asymmetricKeyType!=='ed25519')throw new TypeError('only Ed25519 keys supported');
  return verify(null,signedPayload(report),key,bytes);
}
/** CLI-facing compile + evaluation; private keys never accepted through the JSON interface. */
export function runCertaintyContract(input){
  object(input,'contract evaluation',['contract','observations']);
  return evaluateCertaintyContract(compileCertaintyContract(input.contract),input.observations);
}
