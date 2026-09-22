import test from 'node:test';
import assert from 'node:assert/strict';
import {auditOriginalScope} from '../scripts/audit-original-scope.mjs';

test('100 original IDs have source identity and golden execution, not unearned scope certification',async()=>{
  const report=await auditOriginalScope();
  assert.equal(report.engineIds,100);
  assert.equal(report.exampleMatches,100);
  assert.equal(report.originalScopeCertifiedCount,0);
  assert.deepEqual(report.rows.map(row=>row.id),Array.from({length:100},(_,i)=>i+1));
  assert.ok(report.rows.every(row=>row.sourceSha256.length===64&&row.exampleSha256.length===64&&row.originalScopeCertified===false));
  for(const id of [81,89,95,96]){
    const row=report.rows[id-1];
    assert.ok(row.historicalOpenScope.length>20,`#${id} missing historical acceptance gap`);
    assert.equal(row.exampleMatched,true);
  }
  assert.equal(report.rows[81-1].historicalCurrentScope.includes('no signature'),true);
  assert.equal(report.rows[89-1].historicalCurrentScope.includes('not FHE'),true);
  assert.equal(report.rows[95-1].historicalCurrentScope.includes('not a general zk-SNARK'),true);
});
