/* Independently authored test harness: never computes an expected answer through GAUSS. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GAUSS_IMPLEMENTED_LAYERS,getGaussLayer} from '../core/registry.mjs';
export const seq=n=>Array.from({length:n},(_,i)=>i);
export const gcd=(a,b)=>{a=BigInt(a);b=BigInt(b);while(b)[a,b]=[b,a%b];return a<0n?-a:a;};
export const frac=(a,b=1n)=>{a=BigInt(a);b=BigInt(b);if(!b)throw Error('zero denominator');if(b<0n){a=-a;b=-b;}const d=gcd(a,b);return `${a/d}/${b/d}`;};
export const makeRng=seed=>{let x=seed>>>0;return n=>{if(!Number.isSafeInteger(n)||n<=0)throw Error('bad RNG bound');x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)%n;};};
const near=(a,b)=>typeof a==='number'&&typeof b==='number'&&Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-12*Math.max(1,Math.abs(b));
export function runBatchBank({name,prefix,start,tags,input,reference,verify,invalid,resolveLayer=getGaussLayer}){
 assert.equal(GAUSS_IMPLEMENTED_LAYERS.length,1000);
 assert.equal(tags.length,25,`${name}: exactly 25 explicit reference operators`);
 assert.equal(new Set(tags).size,25,`${name}: duplicate tag`);
 const report={schemaVersion:1,subject:name,seed:'sha256(operator-id):0x238437',oracle:'Independent domain-specific reference functions, deterministic bounded inputs and structural rejection',registryOperators:1000,coveredOperators:0,validCases:0,passedValidCases:0,failedValidCases:0,invalidCases:0,passedInvalidRejections:0,failedInvalidRejections:0,operatorResults:[],failures:[],caseDigest:''};
 const digest=createHash('sha256');
 for(const [index,tag] of tags.entries()){
  const id=`GAUSS.${prefix}.${tag}.${start+index}`,subject=resolveLayer(id);
  assert.equal(typeof subject?.execute,'function',`missing GAUSS operator: ${id}`);
  const seed=Number.parseInt(createHash('sha256').update(id).digest('hex').slice(0,8),16)^0x238437;
  const random=makeRng(seed),item={id,validCases:0,passed:0,failed:0,invalidCases:0,rejected:0,invalidAccepted:0};
  for(let caseIndex=0;caseIndex<100;caseIndex++){
   const data=input(tag,caseIndex,random);
   let expected;
   try{expected=reference(tag,structuredClone(data));}catch(error){throw Error(`Invalid AXIOMA reference/case for ${id} ${caseIndex}: ${error.stack??error}`);}
   digest.update(JSON.stringify({id,caseIndex,data,expected}));
   report.validCases++;item.validCases++;
   let actual;
   try{
    actual=subject.execute(structuredClone(data));
    if(verify)verify(tag,structuredClone(data),actual,expected);
    else assert.deepStrictEqual(actual,expected);
    report.passedValidCases++;item.passed++;
   }catch(error){report.failedValidCases++;item.failed++;if(report.failures.length<24)report.failures.push({id,caseIndex,input:data,expected,actual:actual??null,reason:String(error)});}
   if(caseIndex===0){
    const bad=invalid?invalid(tag,data):[{...data,AXIOMA_INVALID_EXTRA:true},{...data,[Object.keys(data)[0]]:null},null];
    assert.equal(bad.length,3,`invalid denominator ${id}`);
    for(const [i,b] of bad.entries()){
     report.invalidCases++;item.invalidCases++;
     try{const result=subject.execute(structuredClone(b));report.failedInvalidRejections++;item.invalidAccepted++;if(report.failures.length<24)report.failures.push({id,caseIndex:`invalid-${i}`,input:b,actual:result,reason:'malformed input accepted'});}
     catch{report.passedInvalidRejections++;item.rejected++;}
    }
   }
  }
  report.coveredOperators++;report.operatorResults.push(item);
 }
 report.untestedOperators=1000-report.coveredOperators;report.validPassRate=report.passedValidCases/report.validCases;report.invalidRejectionRate=report.passedInvalidRejections/report.invalidCases;report.caseDigest=`sha256:${digest.digest('hex')}`;
 return report;
}
export function verifyExactOrNear(actual,expected){assert.deepStrictEqual(Object.keys(actual),Object.keys(expected));for(const k of Object.keys(expected)){if(typeof expected[k]==='number')assert.ok(near(actual[k],expected[k]),`numeric mismatch ${k}: ${actual[k]} != ${expected[k]}`);else assert.deepStrictEqual(actual[k],expected[k]);}}
