// Real cross-runtime smoke: Rust produces a synthetic verified archive record;
// this process runs the existing GAUSS/Quantum implementation unchanged.
// It is not a production data connector or a real-world forecast.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GAUSS_ENGINE_ID } from '../../gauss/core/common.mjs';
import { executeGaussProblem, validateGaussProblem } from '../../gauss/core/problem.mjs';
import { contributeNexusQuantum } from '../../gauss/core/quantum-contributor.mjs';

function parseFixture(text) {
  if (typeof text !== 'string' || text.length > 1024) throw Error('invalid fixture length');
  const fields = text.trimEnd().split('\t');
  if (fields.length !== 6 || fields[0] !== 'LEIBNIZ_SYNTHETIC_RATE_V1')
    throw Error('unexpected LEIBNIZ fixture protocol');
  const [, problemId, instant, rawValue, unit, evidenceId] = fields;
  if (problemId !== 'leibniz-gauss-fixture' || instant !== '150'
    || unit !== 'contacts/s' || evidenceId !== 'fixture:rate'
    || !/^[0-9]+(?:\.[0-9]+)?$/u.test(rawValue))
    throw Error('LEIBNIZ synthetic fixture type, provenance or time mismatch');
  const rate = Number(rawValue);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1_000_000)
    throw Error('LEIBNIZ rate outside GAUSS numerical bounds');
  return Object.freeze({ problemId, instant: Number(instant), rate, unit, evidenceId });
}
function toGaussFixtureProblem(source) {
  // 1*x=rate is an explicitly selected fixture identity linear system.
  // The archive provides RHS; GAUSS executes the genuine numerical solver.
  return validateGaussProblem({
    schemaVersion: 1,
    problemId: `${source.problemId}:identity-solve`,
    objective: 'Synthetic identity solve of source-bound rate; no forecast',
    tasks: [{ taskId: 'fixture-measured-rate',
      layerId: 'GAUSS.MATH.GAUSSIAN_SOLVE.005',
      input: { coefficients: [[1]], rhs: [source.rate] } }],
  });
}
const fixturePath = process.env.LEIBNIZ_SYNTHETIC_FIXTURE;
if (!fixturePath) throw Error('missing Rust-produced fixture path');
const source = parseFixture(readFileSync(fixturePath, 'utf8'));
assert.equal(source.rate, 2.5);
const problem = toGaussFixtureProblem(source);
const report = await executeGaussProblem(problem, { quantumContributor: contributeNexusQuantum });
assert.equal(report.engineId, GAUSS_ENGINE_ID);
assert.equal(report.status, 'PASS', JSON.stringify(report.errors));
assert.equal(report.failedLayerCount, 0);
assert.equal(report.executedLayerCount, 1);
assert.equal(report.problemId, problem.problemId);
assert.equal(report.taskResults[0].status, 'EXECUTED');
assert.equal(report.taskResults[0].output.solution[0], source.rate);
assert.equal(report.taskResults[0].output.residualInfinityNorm, 0);
assert.equal(report.quantumContribution?.engineId, 'NEXUS_QUANTUM');
assert.equal(report.quantumContribution?.status, 'NOT_APPLICABLE');
assert.equal(report.quantumContribution?.problemSha256, report.problemSha256);
const existing = await executeGaussProblem({
  schemaVersion: 1, problemId: 'leibniz-gauss-fixture:identity-solve',
  objective: 'Synthetic identity solve of source-bound rate; no forecast',
  tasks: [{ taskId: 'fixture-measured-rate',
    layerId: 'GAUSS.MATH.GAUSSIAN_SOLVE.005',
    input: { coefficients: [[1]], rhs: [2.5] } }],
}, { quantumContributor: contributeNexusQuantum });
assert.equal(report.reportSha256, existing.reportSha256);
for (const forged of [
  'LEIBNIZ_SYNTHETIC_RATE_V1\tleibniz-gauss-fixture\t150\tNaN\tcontacts/s\tfixture:rate',
  'LEIBNIZ_SYNTHETIC_RATE_V1\tleibniz-gauss-fixture\t150\t2.5\tUSD\tfixture:rate',
  'LEIBNIZ_SYNTHETIC_RATE_V1\tleibniz-gauss-fixture\t250\t2.5\tcontacts/s\tfixture:rate',
  'LEIBNIZ_SYNTHETIC_RATE_V1\tleibniz-gauss-fixture\t150\t2.5\tcontacts/s\tmissing',
  'LEIBNIZ_SYNTHETIC_RATE_V1\tleibniz-gauss-fixture\t150\t2.5\tcontacts/s\tfixture:rate\tFORGED',
]) assert.throws(() => parseFixture(forged));
console.log('PASS: Rust archive -> real GAUSS solver + Quantum receipt; baseline replay identical; forged fixture values rejected');
