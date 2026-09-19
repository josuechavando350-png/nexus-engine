import { assertArray, assertExactKeys, assertObject, assertToken, deepFreeze, sha256Canonical } from '../core/common.mjs';
import { executeGaussProblem } from '../core/problem.mjs';
import { contributeNexusQuantum } from '../core/quantum-contributor.mjs';
import { updateBinaryBayes } from './bayes.mjs';
import { betaBernoulliBatch } from './bayes-stream.mjs';
import { persistentHomologyZero } from './persistent-h0.mjs';
import { solveFinitePomdp } from './pomdp.mjs';
import { evaluateBinaryIntervention } from './causal.mjs';
import { solveFiniteBimatrixGame } from './game-theory.mjs';
import { checkFiniteTransitionSystem } from './model-check.mjs';
import { inferHiddenMarkov } from './hidden-markov.mjs';
import { simulateCoinedQuantumWalk } from './quantum-walk.mjs';
import { filterVectorKalman } from './kalman-vector.mjs';
import { synchronizeClockIntervals } from './chronos.mjs';
import { reduceIntervalType2 } from './type2-fuzzy.mjs';
import { solvePureStackelberg } from './stackelberg.mjs';
import { optimizeRobustScenarios } from './robust-scenarios.mjs';
import { queryTemporalGraph } from './temporal-graph.mjs';
import { solveDiscountedMdp } from './discounted-mdp.mjs';
import { certifyFiniteErgodicity } from './ergodic-chain.mjs';
import { estimateBinaryTransferEntropy } from './transfer-entropy.mjs';

export const GAUSS_ADVANCED_OPERATORS = Object.freeze({
  FORMAL_FINITE_REACHABILITY_V1: checkFiniteTransitionSystem,
  BAYES_BINARY_EXACT_V1: updateBinaryBayes,
  CAUSAL_BINARY_INTERVENTION_V1: evaluateBinaryIntervention,
  GAME_FINITE_NASH_V1: solveFiniteBimatrixGame,
  BAYES_BERNOULLI_STREAM_V1: betaBernoulliBatch,
  TDA_PERSISTENT_H0_V1: persistentHomologyZero,
  POMDP_FINITE_HORIZON_V1: solveFinitePomdp,
  HIDDEN_MARKOV_BINARY_EXACT_V1: inferHiddenMarkov,
  QUANTUM_WALK_HADAMARD_CYCLE_V1: simulateCoinedQuantumWalk,
  KALMAN_VECTOR_LINEAR_GAUSSIAN_V1: filterVectorKalman,
  CHRONOS_CLOCK_OFFSET_INTERVAL_V1: synchronizeClockIntervals,
  FUZZY_INTERVAL_TYPE2_KM_V1: reduceIntervalType2,
  STACKELBERG_FINITE_PURE_V1: solvePureStackelberg,
  ROBUST_FINITE_SCENARIOS_V1: optimizeRobustScenarios,
  TEMPORAL_GRAPH_SHORTEST_PATH_V1: queryTemporalGraph,
  DISCOUNTED_MDP_EXACT_V1: solveDiscountedMdp,
  FINITE_MARKOV_ERGODICITY_V1: certifyFiniteErgodicity,
  TRANSFER_ENTROPY_BINARY_LAG1_V1: estimateBinaryTransferEntropy,
});

// Only previous successful task outputs may supply a value. Object-key inspection
// prevents prototype traversal, while output hashes bind every dependency.
function resolveInput(value, sources, dependencies, depth = 0) {
  if (depth > 32) throw new RangeError('input reference nesting exceeds limit');
  if (Array.isArray(value)) return value.map((item) => resolveInput(item, sources, dependencies, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  if (Object.hasOwn(value, '$ref')) {
    assertExactKeys(value, ['$ref'], 'output reference');
    assertExactKeys(value.$ref, ['taskId', 'path'], 'output reference target');
    const id = assertToken(value.$ref.taskId, 'output reference taskId');
    const path = assertArray(value.$ref.path, 'output reference path', { min: 1, max: 32 });
    const source = sources.get(id);
    if (!source || source.status !== 'EXECUTED') throw new TypeError(`missing or failed upstream output: ${id}`);
    let result = source.output;
    for (const key of path) {
      if ((typeof key !== 'string' && !Number.isSafeInteger(key))
        || ['__proto__', 'prototype', 'constructor'].includes(String(key))
        || !result || typeof result !== 'object' || !Object.hasOwn(result, key)) {
        throw new TypeError(`unresolvable upstream output path: ${id}`);
      }
      result = result[key];
    }
    dependencies.set(id, source.outputSha256);
    return structuredClone(result);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveInput(item, sources, dependencies, depth + 1)]));
}

/** A separate GAUSS extension so the audited 1,000-operator registry remains unchanged. */
export async function executeGaussAdvancedProblem(problem) {
  assertObject(problem, 'GAUSS advanced problem');
  const allowed = ['schemaVersion', 'problemId', 'objective', 'tasks', 'gaussTasks'];
  if (Object.keys(problem).some((key) => !allowed.includes(key)) || !['schemaVersion', 'problemId', 'objective', 'tasks'].every((key) => Object.hasOwn(problem, key))) {
    throw new TypeError('advanced problem keys mismatch');
  }
  if (problem.schemaVersion !== 1) throw new TypeError('unsupported advanced problem schemaVersion');
  const problemId = assertToken(problem.problemId, 'problemId');
  if (typeof problem.objective !== 'string' || !problem.objective.trim() || problem.objective.length > 16_384) throw new TypeError('invalid objective');
  const tasks = assertArray(problem.tasks, 'tasks', { min: 1, max: 32 });
  const used = new Set();
  for (const [i, task] of tasks.entries()) {
    assertExactKeys(task, ['taskId', 'operatorId', 'input'], `tasks[${i}]`);
    assertToken(task.taskId, `tasks[${i}].taskId`);
    if (used.has(task.taskId)) throw new TypeError('duplicate task ID');
    used.add(task.taskId);
    if (!Object.hasOwn(GAUSS_ADVANCED_OPERATORS, task.operatorId)) throw new TypeError(`unimplemented advanced operator: ${task.operatorId}`);
    assertObject(task.input, `tasks[${i}].input`);
  }
  const gaussTasks = problem.gaussTasks === undefined ? [] : assertArray(problem.gaussTasks, 'gaussTasks', { max: 32 });
  for (const [i, task] of gaussTasks.entries()) {
    assertExactKeys(task, ['taskId', 'layerId', 'input'], `gaussTasks[${i}]`);
    assertToken(task.taskId, `gaussTasks[${i}].taskId`);
    if (used.has(task.taskId)) throw new TypeError('task IDs must be unique across GAUSS and advanced operators');
    used.add(task.taskId);
  }
  // Hash and clone the *actual supplied input* before any calculation.
  const source = structuredClone(problem);
  const inputSha256 = sha256Canonical(source);
  const linkedCore = gaussTasks.length ? await executeGaussProblem({
    schemaVersion: 1, problemId: `${problemId}:core`, objective: problem.objective, tasks: gaussTasks,
  }, { quantumContributor: contributeNexusQuantum }) : null;
  const results = [];
  const sources = new Map(linkedCore?.taskResults.map((result) => [result.taskId, result]) ?? []);
  for (const task of tasks) {
    const dependencies = new Map();
    const declaredInputSha256 = sha256Canonical(task.input);
    try {
      const resolved = resolveInput(structuredClone(task.input), sources, dependencies);
      const output = await GAUSS_ADVANCED_OPERATORS[task.operatorId](resolved);
      const entry = { taskId: task.taskId, operatorId: task.operatorId, status: 'EXECUTED',
        declaredInputSha256, inputSha256: sha256Canonical(resolved),
        dependencies: [...dependencies].map(([taskId, outputSha256]) => ({ taskId, outputSha256 })),
        output, outputSha256: sha256Canonical(output) };
      results.push(entry);
      sources.set(task.taskId, entry);
    } catch (error) {
      const entry = { taskId: task.taskId, operatorId: task.operatorId, status: 'FAILED', declaredInputSha256, inputSha256: null,
        dependencies: [...dependencies].map(([taskId, outputSha256]) => ({ taskId, outputSha256 })), output: null, outputSha256: null,
        error: String(error?.message ?? error).replace(/[\r\n]+/gu, ' ').slice(0, 500) };
      results.push(entry);
      sources.set(task.taskId, entry);
    }
  }
  const unsigned = {
    schemaVersion: 1,
    engineId: 'NEXUS_GAUSS_ADVANCED_V1',
    status: results.every((r) => r.status === 'EXECUTED') && (linkedCore === null || linkedCore.status === 'PASS') ? 'PASS' : 'BLOCKED',
    problemId,
    inputSha256,
    advancedOperatorCount: Object.keys(GAUSS_ADVANCED_OPERATORS).length,
    taskResults: results,
    linkedGaussReportSha256: linkedCore?.reportSha256 ?? null,
    linkedGaussStatus: linkedCore?.status ?? 'NOT_REQUESTED',
    linkedQuantumReceiptSha256: linkedCore?.quantumContribution?.receiptSha256 ?? linkedCore?.quantumContribution?.simulation?.receiptSha256 ?? null,
    guaranteeScope: 'Exact computation or exhaustive checking only within the specified bounded models; no universal accuracy claim.',
  };
  return deepFreeze({ ...unsigned, reportSha256: sha256Canonical(unsigned) });
}
