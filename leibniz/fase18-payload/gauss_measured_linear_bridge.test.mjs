import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMeasuredRateLine, runMeasuredLinearBridge } from './gauss_measured_linear_bridge.mjs';

const binaryPath = process.env.LEIBNIZ_BRIDGE_EXPORT_BINARY;
const generatorPath = process.env.LEIBNIZ_BRIDGE_SOURCE_GENERATOR;
if (!binaryPath || !generatorPath) throw new Error('real Rust bridge and source-generator binaries required');
const dir = mkdtempSync(join(tmpdir(), 'leibniz-bridge-contract-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let counter = 0;
function source(left, right) {
  const id = ++counter;
  const archivePath = join(dir, `${id}.archive`);
  const pinPath = join(dir, `${id}.independently-pinned-test-only`);
  execFileSync(generatorPath, [archivePath, pinPath, String(left), String(right)], { timeout: 15_000 });
  return { archivePath, pinPath };
}
function request(paths, coefficients = [[2, 0], [0, 4]]) {
  return { binaryPath, ...paths, problemId: 'bridge-varied-case', asOfUtcMs: 150,
    direction: 'MAXIMIZE', coefficients, selections: [
      { fromEntity: 'source', toEntity: 'left', unit: 'contacts/s' },
      { fromEntity: 'source', toEntity: 'right', unit: 'contacts/s' },
    ] };
}

test('actual Rust archive with TWO distinct rates drives real GAUSS and Quantum', async () => {
  const result = await runMeasuredLinearBridge(request(source(2.5, 7.25)));
  assert.deepEqual(result.solution, [1.25, 1.8125]);
  assert.deepEqual(result.sourceRows.map((r) => r.value), [2.5, 7.25]);
  assert.deepEqual(result.sourceRows.map((r) => r.evidenceIds), [['synthetic:left'], ['synthetic:right']]);
  assert.equal(result.assurance, 'MEASURED_INPUT_NUMERIC_SOLVE_ONLY');
  assert.match(result.sourceSha256, /^[a-f0-9]{64}$/u);
  for (const digest of [result.problemSha256, result.gaussReportSha256,
    result.quantumReceiptSha256]) assert.match(digest, /^sha256:[a-f0-9]{64}$/u);
});

test('changing measurements and operator-supplied matrix changes genuine numerical output', async () => {
  const result = await runMeasuredLinearBridge(request(source(3, 5), [[1, 1], [1, -1]]));
  assert.deepEqual(result.solution, [4, -1]);
  assert.deepEqual(result.sourceRows.map((r) => r.value), [3, 5]);
});

test('changed source cannot reuse the previous independent byte pin', async () => {
  const paths = source(2.5, 7.25);
  const original = readFileSync(paths.archivePath);
  writeFileSync(paths.archivePath, Buffer.concat([original, Buffer.from([42])]));
  await assert.rejects(runMeasuredLinearBridge(request(paths)), /archive differs from independent pin/u);
});

test('source and pin cannot be the same file under a renamed path', async () => {
  const paths = source(2.5, 7.25);
  await assert.rejects(runMeasuredLinearBridge(request({ archivePath: paths.archivePath,
    pinPath: paths.archivePath })), /distinct files/u);
});

test('expired time, undeclared unit, and missing edge all fail before GAUSS', async () => {
  const paths = source(2.5, 7.25);
  await assert.rejects(runMeasuredLinearBridge({ ...request(paths), asOfUtcMs: 200 }));
  const req = request(paths);
  req.selections[0].unit = 'USD/s';
  await assert.rejects(runMeasuredLinearBridge(req));
  const missing = request(paths);
  missing.selections[0].toEntity = 'missing';
  await assert.rejects(runMeasuredLinearBridge(missing));
});

test('malformed binary64, forged evidence, and extra lines never parse as measurements', () => {
  const paths = source(2.5, 7.25);
  const original = execFileSync(binaryPath, [paths.archivePath, paths.pinPath,
    'bridge-varied-case', '150', 'source', 'left', 'contacts/s', 'MAXIMIZE'], { encoding: 'utf8' });
  const fields = original.trimEnd().split('\t');
  assert.equal(parseMeasuredRateLine(original).value, 2.5);
  const forgedValue = [...fields];
  forgedValue[5] = '7ff8000000000000';
  assert.throws(() => parseMeasuredRateLine(forgedValue.join('\t')), /binary64|nonfinite/u);
  const forgedCount = [...fields];
  forgedCount[8] = '2';
  assert.throws(() => parseMeasuredRateLine(forgedCount.join('\t')), /evidence count/u);
  assert.throws(() => parseMeasuredRateLine(original + original), /multiple lines/u);
  const forgedUnit = [...fields];
  forgedUnit[6] = Buffer.from('USD/s').toString('hex');
  assert.equal(parseMeasuredRateLine(forgedUnit.join('\t')).unit, 'USD/s');
  // A text record alone does NOT authenticate a unit: the execution path also
  // checks exact selection against the actual trusted Rust process output.
});

test('duplicate evidence edge and invalid numerical model cannot return PASS', async () => {
  const paths = source(2.5, 7.25);
  const duplicate = request(paths);
  duplicate.selections[1] = { ...duplicate.selections[0] };
  await assert.rejects(runMeasuredLinearBridge(duplicate), /duplicate directed edge/u);
  await assert.rejects(runMeasuredLinearBridge(request(paths, [[1, 1], [2, 2]])), /rejected|residual/u);
});
