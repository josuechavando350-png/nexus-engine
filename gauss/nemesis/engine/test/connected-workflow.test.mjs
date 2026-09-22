import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditIngestionWorkflow, applyReverseIngestion, verifyContractAttestation, signPassingContract } from '../src/motors/index.mjs';
import { generateKeyPairSync } from 'node:crypto';
const fixture=()=>JSON.parse(readFileSync(new URL('../examples/audited-ingestion.json',import.meta.url),'utf8'));
test('16–20 five engines feed one evaluated gate; apply is still explicitly separate',()=>{
  const x=fixture(),result=auditIngestionWorkflow(x);
  assert.equal(result.status,'PASS');assert.equal(result.graph.connected,true);
  assert.deepEqual(result.ontology.inferredTypes.note1,['Record','Document']);
  assert.equal(result.catalog.documentCount,1);assert.equal(result.reconciliation.plan.operations.length,1);
  assert.equal(result.contract.manifest.artifactSha256,result.reconciliation.planHash);
  assert.equal(result.evaluation.checks.every(c=>c.pass),true);
  assert.deepEqual(x.reverseIngestion.destination,[]);
  const applied=applyReverseIngestion(result.reconciliation,x.reverseIngestion.destination);
  assert.equal(applied.appliedCount,1);
});
test('16–20 workflow fails closed on disconnected graph and inadequate change budget',()=>{
  const x=fixture();x.graph.edges=[];x.maxChanges=0;
  const r=auditIngestionWorkflow(x);
  assert.equal(r.status,'FAIL');
  assert.deepEqual(r.evaluation.checks.filter(c=>!c.pass).map(c=>c.metric),['connected','plannedChanges']);
  assert.deepEqual(x.reverseIngestion.destination,[]);
});
test('16–20 signature binds in-memory audit to original observations, not physical provenance',()=>{
  const x=fixture(),r=auditIngestionWorkflow(x),keys=generateKeyPairSync('ed25519');
  const privatePem=keys.privateKey.export({format:'pem',type:'pkcs8'}),publicPem=keys.publicKey.export({format:'pem',type:'spki'});
  const signed=signPassingContract(r.evaluation,privatePem);
  assert.equal(verifyContractAttestation(r.contract,r.evaluation.observations,signed,publicPem),true);
  const revised=fixture();revised.reverseIngestion.source[0].data.ready=0;
  const changed=auditIngestionWorkflow(revised);
  assert.equal(verifyContractAttestation(changed.contract,changed.evaluation.observations,signed,publicPem),false);
});
