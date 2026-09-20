#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sha256Canonical } from '../gauss/core/common.mjs';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'forja/fixtures/gauss-quantum-contract.json');
const CLI = join(ROOT, 'scripts/nexus-gauss.mjs');
const LAYER = 'GAUSS.PHYSICS.ISING_EXACT_GROUND.003';

function check(condition, message) {
  if (!condition) throw new Error(`FORJA_CONTRACT_FAIL: ${message}`);
}

// Independent finite-state oracle. This does not call GAUSS or the Quantum simulator.
export function exactIsingOracle({ fields, couplings = [], offset = 0 }) {
  check(Array.isArray(fields) && fields.length >= 1 && fields.length <= 12 && fields.every(Number.isFinite), 'invalid oracle fields');
  check(Number.isFinite(offset) && Array.isArray(couplings), 'invalid oracle Hamiltonian');
  const edges = new Set();
  for (const edge of couplings) {
    check(edge && Number.isInteger(edge.i) && Number.isInteger(edge.j) && edge.i >= 0 && edge.j < fields.length && edge.i < edge.j && Number.isFinite(edge.value), 'invalid oracle coupling');
    const id = `${edge.i}:${edge.j}`;
    check(!edges.has(id), 'duplicate oracle coupling');
    edges.add(id);
  }
  let energy = Infinity;
  let degeneracy = 0;
  let spins = null;
  for (let bits = 0; bits < 2 ** fields.length; bits += 1) {
    const state = fields.map((_, i) => (bits & (2 ** i)) === 0 ? 1 : -1);
    let candidate = offset;
    for (let i = 0; i < fields.length; i += 1) candidate += fields[i] * state[i];
    for (const edge of couplings) candidate += edge.value * state[edge.i] * state[edge.j];
    if (candidate < energy) {
      energy = candidate;
      degeneracy = 1;
      spins = state;
    } else if (candidate === energy) degeneracy += 1;
  }
  return { energy, degeneracy, spins, evaluatedStates: 2 ** fields.length };
}

export function assertGaussQuantumContract(problem, report) {
  check(problem && problem.schemaVersion === 1 && Array.isArray(problem.tasks) && problem.tasks.length === 1, 'unexpected fixture contract');
  const [task] = problem.tasks;
  check(task?.taskId === 'ising-contract' && task.layerId === LAYER, 'required Ising task not declared');
  const expected = exactIsingOracle(task.input);
  check(report && typeof report === 'object' && report.engineId === 'NEXUS_GAUSS_SCIENTIFIC_KERNEL_V1' && report.status === 'PASS', 'GAUSS did not PASS');
  check(report.problemId === problem.problemId && report.problemSha256 === sha256Canonical(problem), 'problem identity or digest mismatch');
  check(report.executedLayerCount === 1 && report.failedLayerCount === 0 && report.taskResults?.length === 1 && report.errors?.length === 0, 'execution coverage mismatch');
  const [result] = report.taskResults;
  check(result.taskId === task.taskId && result.layerId === LAYER && result.status === 'EXECUTED' && result.inputSha256 === sha256Canonical(task.input), 'GAUSS task contract mismatch');
  check(result.outputSha256 === sha256Canonical(result.output), 'GAUSS output digest mismatch');
  check(result.output?.energy === expected.energy && result.output?.degeneracy === expected.degeneracy
    && result.output?.evaluatedStates === expected.evaluatedStates
    && JSON.stringify(result.output?.spins) === JSON.stringify(expected.spins), 'GAUSS output differs from independent finite oracle');
  const quantum = report.quantumContribution;
  check(quantum?.engineId === 'NEXUS_QUANTUM' && quantum.status === 'EXECUTED' && quantum.problemSha256 === report.problemSha256, 'Quantum execution or problem binding missing');
  check(quantum.sourceTaskId === task.taskId && quantum.sourceTaskOutputSha256 === result.outputSha256, 'Quantum receipt not bound to GAUSS output');
  const simulation = quantum.simulation;
  check(simulation?.verdict === 'PASS' && simulation.hardwareExecution === false && simulation.quantumAdvantageClaimAllowed === false, 'classical Quantum evidence invalid');
  check(simulation.problemSha256 === sha256Canonical({ problemId: `${problem.problemId}:ising`, ...task.input }), 'Quantum Hamiltonian digest mismatch');
  check(simulation.exactGroundStateEnergy === expected.energy, 'Quantum energy differs from independent oracle');
  const { receiptSha256, ...simulationUnsigned } = simulation;
  check(receiptSha256 === sha256Canonical(simulationUnsigned), 'Quantum simulation receipt digest mismatch');
  const { reportSha256, ...reportUnsigned } = report;
  check(reportSha256 === sha256Canonical(reportUnsigned), 'GAUSS report digest mismatch');
  return Object.freeze({
    schemaVersion: 1, tool: 'AXIOMA_FORJA_EXECUTED_GAUSS_QUANTUM_CONTRACT', status: 'PASS',
    sourceRevision: null, scope: 'single-Ising-problem-real-CLI', problemSha256: report.problemSha256,
    gaussReportSha256: reportSha256, quantumReceiptSha256: receiptSha256,
    oracle: expected, checked: { gaussTasks: 1, quantumSimulations: 1, independentIsingStates: expected.evaluatedStates },
    limitations: ['One bounded Ising fixture; no evidence of all GAUSS layers or every Nexus motor.',
      'A classical Quantum simulation is not a physical QPU execution.',
      'Shared GAUSS canonical-hash implementation; mathematical energy oracle is separate.',
      'Not a production, security, availability, or end-to-end user-flow certification.'],
  });
}

export async function runRealContractProbe() {
  const problem = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const { stdout } = await exec(process.execPath, [CLI, FIXTURE], { cwd: ROOT, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
  const evidence = assertGaussQuantumContract(problem, JSON.parse(stdout));
  const { stdout: shaText } = await exec('git', ['rev-parse', 'HEAD'], { cwd: ROOT, timeout: 5_000, maxBuffer: 256, encoding: 'utf8' });
  const sourceRevision = shaText.trim();
  check(/^[a-f0-9]{40}$/.test(sourceRevision), 'invalid source revision');
  check(!process.env.FORJA_SOURCE_SHA || process.env.FORJA_SOURCE_SHA === sourceRevision, 'checked-out revision differs from workflow identity');
  return { ...evidence, sourceRevision };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const report = await runRealContractProbe();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(`FORJA_CONTRACT_ERROR: ${String(error?.message ?? error).replace(/[\r\n]+/gu, ' ').slice(0, 2048)}`);
    process.exitCode = 1;
  }
}
