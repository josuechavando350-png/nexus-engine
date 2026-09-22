import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMeasuredLinearBridge } from './gauss_measured_linear_bridge.mjs';

const ingester = process.env.LEIBNIZ_AUTHORIZED_INGEST_BINARY;
const exporter = process.env.LEIBNIZ_BRIDGE_EXPORT_BINARY;
if (!ingester || !exporter) throw new Error('real Rust ingester and bridge binaries required');
const dir = mkdtempSync(join(tmpdir(), 'leibniz-authorized-ingest-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let next = 0;
function record(left = '2.5', right = '7.25') {
  return `LEIBNIZ_SOURCE_V1\toperator-approved-test\nENTITY\tsource\tOrganization\nENTITY\tleft\tChannel\nENTITY\tright\tChannel\nFLOW\tsource\tleft\t${left}\tcontacts/s\tcontacts:1,time:-1\t1\t100\t200\tevidence-left\nFLOW\tsource\tright\t${right}\tcontacts/s\tcontacts:1,time:-1\t1\t100\t200\tevidence-right\nRESTRICTION\tsource\tleft\tELASTIC\t12\tcontacts\tcontacts:1\t1\t100\t*\tevidence-restriction\n`;
}
function files(text = record()) {
  const id = ++next;
  const sourcePath = join(dir, `${id}.source`);
  const pinPath = join(dir, `${id}.pin-test-only`);
  const archivePath = join(dir, `${id}.archive`);
  // TEST ONLY: these copies are NOT independent attestation or actual records.
  writeFileSync(sourcePath, text);
  writeFileSync(pinPath, text);
  return { sourcePath, pinPath, archivePath };
}
function ingest(paths, approved = 'operator-approved-test') {
  return execFileSync(ingester, [paths.sourcePath, paths.pinPath, approved, paths.archivePath],
    { encoding: 'utf8', timeout: 15_000 });
}
function request(paths) {
  return { binaryPath: exporter, archivePath: paths.archivePath, pinPath: paths.archivePinPath,
    problemId: 'operator-ingested-42', asOfUtcMs: 150,
    coefficients: [[2, 0], [0, 4]],
    selections: [
      { fromEntity: 'source', toEntity: 'left', unit: 'contacts/s' },
      { fromEntity: 'source', toEntity: 'right', unit: 'contacts/s' },
    ] };
}
function archiveAndIndependentPin(paths) {
  ingest(paths);
  const archivePinPath = join(dir, `${++next}.archive-pin-test-only`);
  // TEST ONLY: demonstrate the adapter contract, NOT independent provenance.
  writeFileSync(archivePinPath, readFileSync(paths.archivePath));
  return { ...paths, archivePinPath };
}

test('operator-supplied tabular entities, flows, restrictions become a real GAUSS numerical solve', async () => {
  const paths = archiveAndIndependentPin(files());
  const result = await runMeasuredLinearBridge(request(paths));
  assert.deepEqual(result.solution, [1.25, 1.8125]);
  assert.deepEqual(result.sourceRows.map((row) => row.evidenceIds),
    [['operator-approved-test/evidence-left'], ['operator-approved-test/evidence-right']]);
  assert.equal(result.assurance, 'MEASURED_INPUT_NUMERIC_SOLVE_ONLY');
  assert.match(result.gaussReportSha256, /^sha256:[a-f0-9]{64}$/u);
});

test('distinct operator-supplied records lead to distinct numerical result, not a fixed fixture', async () => {
  const paths = archiveAndIndependentPin(files(record('9', '4')));
  const result = await runMeasuredLinearBridge(request(paths));
  assert.deepEqual(result.solution, [4.5, 1]);
});

test('tampering with source or passing a wrong approved identity creates no archive', () => {
  const changed = files();
  writeFileSync(changed.sourcePath, record('99', '7.25'));
  assert.throws(() => ingest(changed));
  assert.equal(existsSync(changed.archivePath), false);
  const wrongIdentity = files();
  assert.throws(() => ingest(wrongIdentity, 'other-operator'));
  assert.equal(existsSync(wrongIdentity.archivePath), false);
});

test('invalid numeric data and forged duplicate evidence create no archive', () => {
  for (const text of [record('-1', '7.25'), record('NaN', '7.25'),
    record().replace('evidence-right', 'evidence-left')]) {
    const paths = files(text);
    assert.throws(() => ingest(paths));
    assert.equal(existsSync(paths.archivePath), false);
  }
});

test('archive is create-only and a later source mutation cannot reuse its archive pin', async () => {
  const paths = archiveAndIndependentPin(files());
  const saved = readFileSync(paths.archivePath);
  assert.throws(() => ingest(paths));
  assert.deepEqual(readFileSync(paths.archivePath), saved);
  writeFileSync(paths.archivePath, Buffer.concat([saved, Buffer.from([0])]));
  await assert.rejects(runMeasuredLinearBridge(request(paths)), /archive differs from independent pin/u);
});
