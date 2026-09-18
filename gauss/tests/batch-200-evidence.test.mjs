import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BATCH_200_ADDITIONS} from '../core/batch-200-additions.mjs';
import {GAUSS_IMPLEMENTED_LAYERS} from '../core/registry.mjs';
import {sha256Canonical} from '../core/common.mjs';
import {executeGaussProblem} from '../core/problem.mjs';
import {contributeNexusQuantum} from '../core/quantum-contributor.mjs';
import {verifyGaussFoundationEvidence} from '../../walle/gauss-evidence-verify.mjs';
const problem=JSON.parse(await readFile(new URL('../fixtures/selftest-problem.json',import.meta.url),'utf8'));
const report=await executeGaussProblem(problem,{quantumContributor:contributeNexusQuantum});

test('fixture, registry, independent Quantum simulation and WALLE replay agree on exactly 200 executed scientific algorithms',async()=>{
 assert.equal(GAUSS_IMPLEMENTED_LAYERS.length,1000);
 assert.equal(problem.tasks.length,200);
 assert.equal(new Set(problem.tasks.map(x=>x.layerId)).size,200);
 assert.equal(new Set(problem.tasks.map(x=>x.taskId)).size,200);
 assert.equal(new Set(GAUSS_IMPLEMENTED_LAYERS.map(x=>x.execute)).size,1000);
 assert.equal(new Set(BATCH_200_ADDITIONS.map(x=>x.id)).size,84);
 assert.deepEqual(new Set(problem.tasks.map(x=>x.layerId)),new Set(GAUSS_IMPLEMENTED_LAYERS.slice(0,200).map(x=>x.id)));
 for(const definition of BATCH_200_ADDITIONS){
  const tasks=problem.tasks.filter(task=>task.layerId===definition.id);
  assert.equal(tasks.length,1,definition.id);
  assert.deepEqual(tasks[0].input,definition.input,definition.id);
  assert.equal(report.taskResults.filter(x=>x.layerId===definition.id&&x.status==='EXECUTED').length,1,definition.id);
 }
 assert.equal(report.status,'PASS');assert.equal(report.executedLayerCount,200);assert.equal(report.failedLayerCount,0);
 assert.equal(report.quantumContribution.status,'EXECUTED');assert.equal(report.quantumContribution.simulation.hardwareExecution,false);
 const verified=await verifyGaussFoundationEvidence({problem,report});assert.equal(verified.executedLayerCount,200);
});

test('all 84 new outputs are independently replay-rejected when falsified with recalculated SHA-256 digests',async()=>{
 assert.equal(report.status,'PASS');
 for(const definition of BATCH_200_ADDITIONS){
  const fake=structuredClone(report),result=fake.taskResults.find(row=>row.layerId===definition.id);
  assert(result,definition.id);
  result.output={...result.output,forgedOutputClaim:'unearned-pass'};
  result.outputSha256=sha256Canonical(result.output);
  const {reportSha256:previous,...unsigned}=fake;void previous;
  fake.reportSha256=sha256Canonical(unsigned);
  await assert.rejects(verifyGaussFoundationEvidence({problem,report:fake}),/replay differs/u,`${definition.id} accepted forged rehashed evidence`);
 }
});
