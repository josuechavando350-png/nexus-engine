import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { checkFiniteTransitionSystem } from '../advanced/model-check.mjs';
import { updateBinaryBayes } from '../advanced/bayes.mjs';
import { evaluateBinaryIntervention } from '../advanced/causal.mjs';
import { solveFiniteBimatrixGame } from '../advanced/game-theory.mjs';
import { executeGaussAdvancedProblem, GAUSS_ADVANCED_OPERATORS } from '../advanced/index.mjs';
import { executeGaussProblem } from '../core/problem.mjs';
import { contributeNexusQuantum } from '../core/quantum-contributor.mjs';
import { sha256Canonical } from '../core/common.mjs';
import { gaussRegistrySummary } from '../core/registry.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/advanced-v1.json', import.meta.url), 'utf8'));
const clone = (obj) => structuredClone(obj);

test('exhaustive finite graph reports reachable safe target and shortest witness', () => {
  const output = checkFiniteTransitionSystem(fixture.tasks[0].input);
  assert.equal(output.invariantHolds, true);
  assert.equal(output.targetReachable, true);
  assert.deepEqual(output.targetWitness, ['START', 'REVIEW', 'DONE']);
  assert.equal(output.reachableStateCount, 3);
  assert.equal(output.exploredTransitionCount, 2);
});

test('finite graph provides shortest counterexample and does not treat unreachable bad states as violations', () => {
  const bad = clone(fixture.tasks[0].input);
  bad.transitions.push({ from: 'START', to: 'ERROR' });
  const result = checkFiniteTransitionSystem(bad);
  assert.equal(result.invariantHolds, false);
  assert.deepEqual(result.counterexample, ['START', 'ERROR']);
  bad.transitions.pop();
  bad.targetStates = ['ERROR'];
  assert.equal(checkFiniteTransitionSystem(bad).targetReachable, false);
});

test('finite graph rejects duplicates, dangling edges and missing start', () => {
  const a = clone(fixture.tasks[0].input); a.transitions.push(a.transitions[0]);
  assert.throws(() => checkFiniteTransitionSystem(a), /duplicate/);
  const b = clone(fixture.tasks[0].input); b.transitions[0].to = 'UNKNOWN';
  assert.throws(() => checkFiniteTransitionSystem(b), /unknown/);
  const c = clone(fixture.tasks[0].input); c.initial = 'UNKNOWN';
  assert.throws(() => checkFiniteTransitionSystem(c), /initial/);
});

test('Bayes computes positive and negative evidence with exact rational arithmetic', () => {
  assert.deepEqual(updateBinaryBayes(fixture.tasks[1].input).posteriorTrue, '9/13');
  const negative = { ...fixture.tasks[1].input, evidence: 'NEGATIVE' };
  const report = updateBinaryBayes(negative);
  assert.equal(report.posteriorTrue, '1/37');
  assert.equal(report.evidenceProbability, '37/50');
});

test('Bayes fails closed on impossible evidence and invalid probabilities', () => {
  assert.throws(() => updateBinaryBayes({ prior: '0/1', sensitivity: '1/1', falsePositiveRate: '0/1', evidence: 'POSITIVE' }), /zero-probability/);
  assert.throws(() => updateBinaryBayes({ ...fixture.tasks[1].input, prior: '1.5' }), /fraction/);
  assert.throws(() => updateBinaryBayes({ ...fixture.tasks[1].input, prior: '2/1' }), /probability/);
  assert.throws(() => updateBinaryBayes({ ...fixture.tasks[1].input, prior: '1/0' }), /fraction/);
});

test('causal intervention separates confounding from intervention without floating-point error', () => {
  const report = evaluateBinaryIntervention(fixture.tasks[2].input);
  assert.deepEqual(report.observationalRisk, { treatment0: '0/1', treatment1: '1/1' });
  assert.deepEqual(report.interventionalRisk, { do0: '1/2', do1: '1/2' });
  assert.equal(report.averageCausalEffect, '0/1');
  assert.equal(report.evaluatedAssignments, 8);
});

test('causal intervention detects a direct effect and preserves signed exact differences', () => {
  const model = {
    nodes: [
      { id: 'X', parents: [], table: [{ when: {}, probabilityTrue: '1/2' }] },
      { id: 'Y', parents: ['X'], table: [
        { when: { X: 0 }, probabilityTrue: '3/4' },
        { when: { X: 1 }, probabilityTrue: '1/4' },
      ] },
    ], treatment: 'X', outcome: 'Y',
  };
  const result = evaluateBinaryIntervention(model);
  assert.deepEqual(result.interventionalRisk, { do0: '3/4', do1: '1/4' });
  assert.equal(result.averageCausalEffect, '-1/2');
});

test('causal model rejects incomplete tables, invalid DAG order and duplicate rows', () => {
  const badTable = clone(fixture.tasks[2].input); badTable.nodes[1].table.pop();
  assert.throws(() => evaluateBinaryIntervention(badTable), /complete/);
  const badParent = clone(fixture.tasks[2].input); badParent.nodes[0].parents = ['Y'];
  assert.throws(() => evaluateBinaryIntervention(badParent), /precede/);
  const badRow = clone(fixture.tasks[2].input); badRow.nodes[1].table[1].when = { U: 0 };
  assert.throws(() => evaluateBinaryIntervention(badRow), /duplicate/);
});

test('GAUSS advanced is tied to original GAUSS and required Quantum receipt without changing 1000 inventory', async () => {
  const existingCount = gaussRegistrySummary().implementedLayerCount;
  const report = await executeGaussAdvancedProblem(fixture);
  assert.equal(existingCount, 1000);
  assert.equal(gaussRegistrySummary().implementedLayerCount, 1000);
  assert.equal(Object.keys(GAUSS_ADVANCED_OPERATORS).length, 18);
  assert.equal(report.status, 'PASS');
  assert.equal(report.taskResults.length, 5);
  assert(report.taskResults.every((result) => result.status === 'EXECUTED'));
  const { reportSha256, ...unsigned } = report;
  assert.equal(reportSha256, sha256Canonical(unsigned));
  const { taskResults } = report;
  assert.equal(taskResults[0].outputSha256, sha256Canonical(taskResults[0].output));
  const core = await executeGaussProblem({ schemaVersion: 1, problemId: `${fixture.problemId}:core`, objective: fixture.objective, tasks: fixture.gaussTasks }, { quantumContributor: contributeNexusQuantum });
  assert.equal(core.status, 'PASS');
  assert.equal(report.linkedGaussReportSha256, core.reportSha256);
  assert.equal(core.quantumContribution.status, 'EXECUTED');
  assert.equal(core.quantumContribution.simulation.hardwareExecution, false);
  assert.equal(report.linkedQuantumReceiptSha256, core.quantumContribution.simulation.receiptSha256);
  assert.equal(report.linkedGaussStatus, 'PASS');
  assert.equal(report.taskResults[3].output.posteriorTrue, '81/85');
  assert.deepEqual(report.taskResults[3].dependencies, [{ taskId: 'update-belief', outputSha256: report.taskResults[1].outputSha256 }]);
  assert.deepEqual(report.taskResults[4].output.interiorMixedEquilibrium.rowStrategy, ['1/2', '1/2']);
});

test('invalid advanced task fails closed: no synthetic accuracy or PASS', async () => {
  const p = clone(fixture);
  p.tasks[1].input.evidence = 'INVALID';
  const report = await executeGaussAdvancedProblem(p);
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.taskResults[1].status, 'FAILED');
  assert.equal(report.taskResults[1].output, null);
  assert.equal(report.taskResults[1].outputSha256, null);
  assert.notEqual(report.reportSha256, (await executeGaussAdvancedProblem(fixture)).reportSha256);
});

test('duplicate IDs, unsupported operators and invalid core input cannot pass', async () => {
  const duplicate = clone(fixture); duplicate.tasks[1].taskId = duplicate.tasks[0].taskId;
  await assert.rejects(executeGaussAdvancedProblem(duplicate), /duplicate task/);
  const unsupported = clone(fixture); unsupported.tasks[0].operatorId = 'ZERO_KNOWLEDGE_MAGIC';
  await assert.rejects(executeGaussAdvancedProblem(unsupported), /unimplemented/);
  const brokenCore = clone(fixture); brokenCore.gaussTasks[0].input = { garbage: 3 };
  const report = await executeGaussAdvancedProblem(brokenCore);
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.linkedGaussStatus, 'BLOCKED');
});

test('deterministic results for identical validated problem', async () => {
  assert.deepEqual(await executeGaussAdvancedProblem(fixture), await executeGaussAdvancedProblem(clone(fixture)));
});

test('causal effect remains defined without observational positivity and flags undefined observations', () => {
  const model = {
    nodes: [
      { id: 'X', parents: [], table: [{ when: {}, probabilityTrue: '1/1' }] },
      { id: 'Y', parents: ['X'], table: [
        { when: { X: 0 }, probabilityTrue: '0/1' },
        { when: { X: 1 }, probabilityTrue: '1/1' },
      ] },
    ], treatment: 'X', outcome: 'Y',
  };
  const result = evaluateBinaryIntervention(model);
  assert.equal(result.observationalRisk.treatment0, null);
  assert.equal(result.observationalRisk.treatment1, '1/1');
  assert.equal(result.averageCausalEffect, '1/1');
});

test('bounded inputs are rejected rather than silently truncated', () => {
  const graph = clone(fixture.tasks[0].input);
  graph.states = Array.from({ length: 65 }, (_, i) => `s${i}`);
  assert.throws(() => checkFiniteTransitionSystem(graph), /bounded length/);
  const causal = clone(fixture.tasks[2].input);
  for (let i = 0; i < 6; i++) causal.nodes.push({ id: `N${i}`, parents: [], table: [{ when: {}, probabilityTrue: '1/2' }] });
  assert.throws(() => evaluateBinaryIntervention(causal), /bounded length/);
});

test('finite model checks a forbidden initial state with length-one counterexample', () => {
  const input = clone(fixture.tasks[0].input);
  input.forbiddenStates.push('START');
  assert.deepEqual(checkFiniteTransitionSystem(input).counterexample, ['START']);
});

test('fraction results preserve Bayes complement and non-decimal exactness', () => {
  const result = updateBinaryBayes({ prior: '1/3', sensitivity: '2/3', falsePositiveRate: '1/3', evidence: 'POSITIVE' });
  assert.equal(result.posteriorTrue, '1/2');
  assert.equal(result.posteriorFalse, '1/2');
  assert.equal(result.evidenceProbability, '4/9');
});

test('advanced-only execution does not pretend Quantum was executed', async () => {
  const problem = clone(fixture);
  delete problem.gaussTasks;
  const result = await executeGaussAdvancedProblem(problem);
  assert.equal(result.status, 'PASS');
  assert.equal(result.linkedGaussStatus, 'NOT_REQUESTED');
  assert.equal(result.linkedQuantumReceiptSha256, null);
});
