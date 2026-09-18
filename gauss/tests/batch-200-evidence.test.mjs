import test from 'node:test';
import assert from 'node:assert/strict';
import {BATCH_200_ADDITIONS} from '../core/batch-200-additions.mjs';
import {buildGaussFoundationFixture} from '../core/foundation-fixture.mjs';
import {GAUSS_IMPLEMENTED_LAYERS} from '../core/registry.mjs';
import {sha256Canonical} from '../core/common.mjs';
import {executeGaussProblem} from '../core/problem.mjs';
import {contributeNexusQuantum} from '../core/quantum-contributor.mjs';
import {verifyGaussFoundationEvidence} from '../../walle/gauss-evidence-verify.mjs';
const problem=await buildGaussFoundationFixture();
const report=await executeGaussProblem(problem,{quantumContributor:contributeNexusQuantum});

test('first 200 preserved and 2 distinct new operators run in connected GAUSS/Quantum/WALLE proof',async()=>{
 assert.equal(GAUSS_IMPLEMENTED_LAYERS.length,202);
 assert.equal(problem.tasks.length,202);
 assert.equal(new Set(problem.tasks.map(x=>x.layerId)).size,202);
 assert.equal(new Set(problem.tasks.map(x=>x.taskId)).size,202);
 assert.equal(new Set(GAUSS_IMPLEMENTED_LAYERS.map(x=>x.execute)).size,202);
 assert.equal(new Set(BATCH_200_ADDITIONS.map(x=>x.id)).size,84);
 assert.deepEqual(new Set(problem.tasks.map(x=>x.layerId)),new Set(GAUSS_IMPLEMENTED_LAYERS.map(x=>x.id)));
 for(const definition of BATCH_200_ADDITIONS){
  const tasks=problem.tasks.filter(task=>task.layerId===definition.id);
  assert.equal(tasks.length,1,definition.id);
  assert.deepEqual(tasks[0].input,definition.input,definition.id);
  assert.equal(report.taskResults.filter(x=>x.layerId===definition.id&&x.status==='EXECUTED').length,1,definition.id);
 }
 assert.deepEqual(problem.tasks.at(-2).layerId,'GAUSS.MATH.CRT_GENERAL.059');
 assert.deepEqual(problem.tasks.at(-1).layerId,'GAUSS.MATH.FINITE_FIELD_MATRIX_INVERSE.060');
 assert.equal(report.status,'PASS');assert.equal(report.executedLayerCount,202);assert.equal(report.failedLayerCount,0);
 assert.equal(report.quantumContribution.status,'EXECUTED');assert.equal(report.quantumContribution.simulation.hardwareExecution,false);
 const verified=await verifyGaussFoundationEvidence({problem,report});assert.equal(verified.executedLayerCount,202);
});

test('all 84 original additions still reject forged outputs with recalculated SHA-256 digests',async()=>{
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

test('WALLE independent arithmetic rejects altered new operators even with recomputed output and report hashes',async()=>{
 assert.equal(report.status,'PASS');
 for(const id of ['GAUSS.MATH.CRT_GENERAL.059','GAUSS.MATH.FINITE_FIELD_MATRIX_INVERSE.060']){
  const fake=structuredClone(report),result=fake.taskResults.find(row=>row.layerId===id);
  if(id==='GAUSS.MATH.CRT_GENERAL.059')result.output.remainder='13';
  else result.output.inverse[0][0]=0;
  result.outputSha256=sha256Canonical(result.output);
  const {reportSha256:previous,...unsigned}=fake;void previous;
  fake.reportSha256=sha256Canonical(unsigned);
  await assert.rejects(verifyGaussFoundationEvidence({problem,report:fake}),/independent/u,`${id} accepted a forged rehashed output`);
 }
});
