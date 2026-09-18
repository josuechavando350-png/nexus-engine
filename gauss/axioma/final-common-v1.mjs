/* Final AXIOMA harness: subjects are read solely for comparison, never to construct expected results. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GAUSS_IMPLEMENTED_LAYERS,getGaussLayer} from '../core/registry.mjs';
import {makeRng} from './batch-238-common.mjs';
export const range=n=>Array.from({length:n},(_,i)=>i);
export function runFinalBank({name,definitions,resolveLayer=getGaussLayer}){
 assert.equal(GAUSS_IMPLEMENTED_LAYERS.length,1000);
 assert.ok(definitions.length>0&&new Set(definitions.map(d=>d.id)).size===definitions.length,'final bank distinct IDs required');
 const report={schemaVersion:1,subject:name,seed:'sha256(id) XOR 0x2631000',oracle:'separately written bounded mathematical references; no GAUSS output used in expected values',registryOperators:1000,coveredOperators:0,validCases:0,passedValidCases:0,failedValidCases:0,invalidCases:0,passedInvalidRejections:0,failedInvalidRejections:0,operatorResults:[],failures:[],caseDigest:''};
 const digest=createHash('sha256');
 for(const def of definitions){
  const layer=resolveLayer(def.id);
  assert.equal(typeof layer?.execute,'function',`missing GAUSS operator ${def.id}`);
  assert.equal(typeof def.make,'function',`missing independently specified inputs ${def.id}`);
  assert.equal(typeof def.reference,'function',`missing independent oracle ${def.id}`);
  const rng=makeRng(Number.parseInt(createHash('sha256').update(def.id).digest('hex').slice(0,8),16)^0x2631000);
  const result={id:def.id,validCases:0,passed:0,failed:0,invalidCases:0,rejected:0,invalidAccepted:0};
  for(let i=0;i<100;i++){
   const input=def.make(i,rng),expected=def.reference(structuredClone(input));
   digest.update(JSON.stringify({id:def.id,index:i,input,expected}));
   report.validCases++;result.validCases++;
   let actual;
   try{actual=layer.execute(structuredClone(input));if(def.verify)def.verify(actual,expected,structuredClone(input));else assert.deepStrictEqual(actual,expected);report.passedValidCases++;result.passed++;}
   catch(error){report.failedValidCases++;result.failed++;if(report.failures.length<16)report.failures.push({id:def.id,index:i,input,expected,actual:actual??null,reason:String(error)});}
   if(i===0){
    const bad=def.invalid?def.invalid(input):[{...input,AXIOMA_UNDECLARED:true},{...input,[Object.keys(input)[0]]:null},null];
    assert.equal(bad.length,3,`three invalid cases per ${def.id}`);
    for(const [j,malformed] of bad.entries()){
     report.invalidCases++;result.invalidCases++;
     try{const output=layer.execute(structuredClone(malformed));report.failedInvalidRejections++;result.invalidAccepted++;if(report.failures.length<16)report.failures.push({id:def.id,index:`invalid-${j}`,input:malformed,actual:output,reason:'malformed input accepted'});}
     catch{report.passedInvalidRejections++;result.rejected++;}
    }
   }
  }
  report.coveredOperators++;report.operatorResults.push(result);
 }
 report.untestedOperators=1000-report.coveredOperators;
 report.validPassRate=report.passedValidCases/report.validCases;
 report.invalidRejectionRate=report.passedInvalidRejections/report.invalidCases;
 report.caseDigest='sha256:'+digest.digest('hex');
 return report;
}
