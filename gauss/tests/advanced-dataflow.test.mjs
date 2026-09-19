import assert from 'node:assert/strict';
import test from 'node:test';
import { executeGaussAdvancedProblem } from '../advanced/index.mjs';
import { sha256Canonical } from '../core/common.mjs';

const bayes = (taskId, prior) => ({ taskId, operatorId: 'BAYES_BINARY_EXACT_V1', input: {
  prior, sensitivity: '9/10', falsePositiveRate: '1/10', evidence: 'POSITIVE',
} });
const ref = (taskId, ...path) => ({ $ref: { taskId, path } });
const problem = (tasks) => ({ schemaVersion: 1, problemId: 'linked-advanced-v1', objective: 'Verify genuine cross-operator data flow', tasks });

test('Bayes posterior drives Pearl intervention in a single linked execution with SHA-bound source', async () => {
  const causal = {
    taskId: 'causal', operatorId: 'CAUSAL_BINARY_INTERVENTION_V1', input: {
      nodes: [
        { id: 'X', parents: [], table: [{ when: {}, probabilityTrue: '1/2' }] },
        { id: 'Y', parents: ['X'], table: [
          { when: { X: 0 }, probabilityTrue: '0/1' },
          { when: { X: 1 }, probabilityTrue: ref('bayes', 'posteriorTrue') },
        ] },
      ], treatment: 'X', outcome: 'Y',
    },
  };
  const report = await executeGaussAdvancedProblem(problem([bayes('bayes', '1/5'), causal]));
  assert.equal(report.status, 'PASS');
  assert.equal(report.taskResults[0].output.posteriorTrue, '9/13');
  assert.equal(report.taskResults[1].output.averageCausalEffect, '9/13');
  assert.deepEqual(report.taskResults[1].dependencies, [{ taskId: 'bayes', outputSha256: report.taskResults[0].outputSha256 }]);
  assert.equal(report.taskResults[1].outputSha256, sha256Canonical(report.taskResults[1].output));
  assert.notEqual(report.taskResults[1].inputSha256, report.taskResults[1].declaredInputSha256);
});

test('missing, forward, failed, and poisoned references fail closed, without downstream PASS', async () => {
  const cases = [
    [bayes('one', ref('missing', 'posteriorTrue'))],
    [bayes('one', ref('two', 'posteriorTrue')), bayes('two', '1/5')],
    [bayes('one', '0/1'), bayes('two', ref('one', 'notAField'))],
    [{ ...bayes('one', '1/5'), input: { ...bayes('one', '1/5').input, evidence: 'INVALID' } }, bayes('two', ref('one', 'posteriorTrue'))],
    [bayes('one', '1/5'), bayes('two', ref('one', '__proto__'))],
  ];
  for (const tasks of cases) {
    const report = await executeGaussAdvancedProblem(problem(tasks));
    assert.equal(report.status, 'BLOCKED');
    assert(report.taskResults.some((result) => result.status === 'FAILED'));
    assert(report.taskResults.filter((result) => result.status === 'FAILED').every((result) => result.outputSha256 === null));
  }
});

test('dependency hash changes if actual upstream input changes; deterministic repeat is identical', async () => {
  const initial = problem([bayes('first', '1/5'), bayes('second', ref('first', 'posteriorTrue'))]);
  const first = await executeGaussAdvancedProblem(initial);
  const repeated = await executeGaussAdvancedProblem(structuredClone(initial));
  assert.deepEqual(first, repeated);
  initial.tasks[0].input.prior = '1/4';
  const changed = await executeGaussAdvancedProblem(initial);
  assert.equal(changed.status, 'PASS');
  assert.notEqual(changed.taskResults[1].inputSha256, first.taskResults[1].inputSha256);
  assert.notEqual(changed.taskResults[1].dependencies[0].outputSha256, first.taskResults[1].dependencies[0].outputSha256);
  assert.notEqual(changed.reportSha256, first.reportSha256);
});
