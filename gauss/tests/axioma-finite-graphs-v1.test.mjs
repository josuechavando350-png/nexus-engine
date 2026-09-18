import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runFiniteGraphBank} from '../axioma/finite-graphs-v1.mjs';
import {getGaussLayer} from '../core/registry.mjs';

test('AXIOMA checks 12 exact finite graph operators with independent bounded enumeration',()=>{
  const report=runFiniteGraphBank();
  assert.equal(report.coveredOperators,12);
  assert.equal(new Set(report.operatorResults.map(x=>x.id)).size,12);
  assert.equal(report.validCases,1200);
  assert.equal(report.passedValidCases,1200,JSON.stringify(report.failures));
  assert.equal(report.failedValidCases,0);
  assert.equal(report.invalidCases,36);
  assert.equal(report.passedInvalidRejections,36,JSON.stringify(report.failures));
  assert.equal(report.failedInvalidRejections,0);
  assert.match(report.caseDigest,/^sha256:[a-f0-9]{64}$/);
  assert.deepStrictEqual(report,runFiniteGraphBank(),'fixed seed, source and cases must reproduce exactly');
  console.log(`AXIOMA_FINITE_GRAPHS_V1=${JSON.stringify({coveredOperators:report.coveredOperators,validCases:report.validCases,passedValidCases:report.passedValidCases,invalidCases:report.invalidCases,passedInvalidRejections:report.passedInvalidRejections,caseDigest:report.caseDigest})}`);
});

test('AXIOMA rejects a fabricated spanning-tree count and acceptance of malformed graphs',()=>{
  const report=runFiniteGraphBank({resolveLayer:id=>id==='GAUSS.CS.SPANNING_TREE_COUNT.021'?{execute:()=>({spanningTrees:'999'})}:getGaussLayer(id)});
  assert.ok(report.failedValidCases>0);
  assert.ok(report.failedInvalidRejections>0);
});
