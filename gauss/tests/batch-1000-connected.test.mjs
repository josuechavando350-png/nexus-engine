import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {GAUSS_IMPLEMENTED_LAYERS,GAUSS_DOMAINS,gaussRegistrySummary} from '../core/registry.mjs';
import {executeGaussProblem} from '../core/problem.mjs';
import {contributeNexusQuantum} from '../core/quantum-contributor.mjs';
import {sha256Canonical} from '../core/common.mjs';
import {verifyGaussFoundationEvidence} from '../../walle/gauss-evidence-verify.mjs';

const fixture=JSON.parse(await readFile(new URL('../fixtures/gauss-1000-selftest.json',import.meta.url),'utf8'));
let report;

test('the historical 200 and 800 new operators have one-to-one registered fixture coverage',()=>{
 assert.equal(GAUSS_IMPLEMENTED_LAYERS.length,1000);
 assert.equal(fixture.tasks.length,1000);
 assert.equal(new Set(GAUSS_IMPLEMENTED_LAYERS.map(x=>x.id)).size,1000);
 assert.equal(new Set(GAUSS_IMPLEMENTED_LAYERS.map(x=>x.execute)).size,1000);
 assert.equal(new Set(fixture.tasks.map(x=>x.layerId)).size,1000);
 assert.equal(new Set(fixture.tasks.map(x=>x.taskId)).size,1000);
 assert.deepEqual(new Set(fixture.tasks.map(x=>x.layerId)),new Set(GAUSS_IMPLEMENTED_LAYERS.map(x=>x.id)));
 assert.equal(GAUSS_DOMAINS.reduce((s,d)=>s+d.targetLayers,0),1000);
 assert.equal(gaussRegistrySummary().implementedLayerCount,1000);
});

test('Nexus executes all 1000; Quantum classical simulation and WALLE independent replay accept proof',async()=>{
 report=await executeGaussProblem(fixture,{quantumContributor:contributeNexusQuantum});
 assert.equal(report.status,'PASS',JSON.stringify(report.errors));
 assert.equal(report.executedLayerCount,1000);
 assert.equal(report.failedLayerCount,0);
 assert.equal(report.taskResults.length,1000);
 assert.equal(report.quantumContribution.status,'EXECUTED');
 assert.equal(report.quantumContribution.simulation.verdict,'PASS');
 assert.equal(report.quantumContribution.simulation.hardwareExecution,false);
 assert.equal(report.quantumContribution.simulation.quantumAdvantageClaimAllowed,false);
 for(let i=0;i<1000;i++){
  assert.equal(report.taskResults[i].layerId,fixture.tasks[i].layerId);
  assert.equal(report.taskResults[i].status,'EXECUTED');
  assert.equal(report.taskResults[i].outputSha256,sha256Canonical(report.taskResults[i].output));
 }
 assert.equal((await verifyGaussFoundationEvidence({problem:fixture,report})).executedLayerCount,1000);
});

test('WALLE replay rejects SHA-rehashed forged results drawn from all eight new 100-operator lots',async()=>{
 assert.equal(report?.status,'PASS');
 for(const index of [200,300,400,500,600,700,800,900]){
  const forged=structuredClone(report);
  forged.taskResults[index].output={...forged.taskResults[index].output,forged:true};
  forged.taskResults[index].outputSha256=sha256Canonical(forged.taskResults[index].output);
  const {reportSha256,...unsigned}=forged;void reportSha256;
  forged.reportSha256=sha256Canonical(unsigned);
  await assert.rejects(verifyGaussFoundationEvidence({problem:fixture,report:forged}),/replay differs/u,`rehashed fraud accepted at task ${index}`);
 }
});
