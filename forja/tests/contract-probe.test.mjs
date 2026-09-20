import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before } from 'node:test';
import { promisify } from 'node:util';
import { sha256Canonical } from '../../gauss/core/common.mjs';
import { assertGaussQuantumContract, exactIsingOracle, runRealContractProbe } from '../contract-probe.mjs';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturePath = join(root, 'forja/fixtures/gauss-quantum-contract.json');
const cli = join(root, 'scripts/nexus-gauss.mjs');
let problem;
let actual;

before(async () => {
  problem = JSON.parse(await readFile(fixturePath, 'utf8'));
  const { stdout } = await exec(process.execPath, [cli, fixturePath], {
    cwd: root, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
  });
  actual = JSON.parse(stdout);
});

function editedReport(change) {
  const report = structuredClone(actual);
  change(report);
  const unsigned = { ...report };
  delete unsigned.reportSha256;
  report.reportSha256 = sha256Canonical(unsigned);
  return report;
}

test('real Nexus GAUSS CLI executes and returns a verified, problem-bound Quantum simulation', () => {
  const evidence = assertGaussQuantumContract(problem, actual);
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.checked.gaussTasks, 1);
  assert.equal(evidence.checked.quantumSimulations, 1);
  assert.equal(evidence.checked.independentIsingStates, 8);
});

test('FORJA runner invokes real CLI and reports the checked-out source commit', async () => {
  const evidence = await runRealContractProbe();
  assert.equal(evidence.status, 'PASS');
  assert.match(evidence.sourceRevision, /^[a-f0-9]{40}$/);
});

test('oracle enumerates an independent finite Hamiltonian including degeneracy', () => {
  assert.deepEqual(exactIsingOracle({ fields: [0, 0], couplings: [{ i: 0, j: 1, value: -1 }] }),
    { energy: -1, degeneracy: 2, spins: [1, 1], evaluatedStates: 4 });
});

test('rejects fabricated GAUSS output even after attacker recomputes hashes and Quantum binding', () => {
  const forged = editedReport((report) => {
    report.taskResults[0].output.energy += 2;
    report.taskResults[0].outputSha256 = sha256Canonical(report.taskResults[0].output);
    report.quantumContribution.sourceTaskOutputSha256 = report.taskResults[0].outputSha256;
    report.quantumContribution.simulation.exactGroundStateEnergy += 2;
    const unsigned = { ...report.quantumContribution.simulation };
    delete unsigned.receiptSha256;
    report.quantumContribution.simulation.receiptSha256 = sha256Canonical(unsigned);
  });
  assert.throws(() => assertGaussQuantumContract(problem, forged), /independent finite oracle/);
});

test('rejects a Quantum receipt that points to another GAUSS task', () => {
  const forged = editedReport((report) => { report.quantumContribution.sourceTaskId = 'wrong-task'; });
  assert.throws(() => assertGaussQuantumContract(problem, forged), /not bound to GAUSS output/);
});

test('rejects a Quantum simulation that falsely declares physical hardware', () => {
  const forged = editedReport((report) => {
    report.quantumContribution.simulation.hardwareExecution = true;
    const unsigned = { ...report.quantumContribution.simulation };
    delete unsigned.receiptSha256;
    report.quantumContribution.simulation.receiptSha256 = sha256Canonical(unsigned);
  });
  assert.throws(() => assertGaussQuantumContract(problem, forged), /classical Quantum evidence invalid/);
});

test('rejects a GAUSS output that has been modified without updating its digest', () => {
  const forged = editedReport((report) => { report.taskResults[0].output.degeneracy += 1; });
  assert.throws(() => assertGaussQuantumContract(problem, forged), /output digest mismatch/);
});

test('rejects a Quantum receipt for a different Hamiltonian', () => {
  const forged = editedReport((report) => {
    report.quantumContribution.simulation.problemSha256 = `sha256:${'0'.repeat(64)}`;
    const unsigned = { ...report.quantumContribution.simulation };
    delete unsigned.receiptSha256;
    report.quantumContribution.simulation.receiptSha256 = sha256Canonical(unsigned);
  });
  assert.throws(() => assertGaussQuantumContract(problem, forged), /Hamiltonian digest mismatch/);
});

test('real GAUSS CLI rejects unsupported layer instead of silently claiming PASS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forja-unsupported-layer-'));
  try {
    const invalid = structuredClone(problem);
    invalid.tasks[0].layerId = 'GAUSS.NOT_IMPLEMENTED';
    const input = join(directory, 'invalid.json');
    await writeFile(input, JSON.stringify(invalid), { mode: 0o600 });
    await assert.rejects(exec(process.execPath, [cli, input], {
      cwd: root, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
    }), /unimplemented GAUSS layer/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
