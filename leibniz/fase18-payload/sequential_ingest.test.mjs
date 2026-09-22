// All records in this suite are SYNTHETIC. Separately copied pins are test
// fixtures; they do not prove supplier authenticity or live-source operation.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { runMeasuredLinearBridge } from './gauss_measured_linear_bridge.mjs';

const cli = process.env.LEIBNIZ_SEQUENTIAL_SOURCE_BINARY;
const bridge = process.env.LEIBNIZ_BRIDGE_EXPORT_BINARY;
if (!cli || !bridge) throw new Error('real LEIBNIZ sequential and bridge executables required');
const dir = mkdtempSync(join(tmpdir(), 'leibniz-sequential-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileId = 0;
const file = (ext) => join(dir, `${++fileId}-${ext}`);
const invoke = (...args) => execFileSync(cli, args, { encoding: 'utf8', timeout: 15_000 });
function rawBatch(rate, target, evidence, category = 'Organization') {
  return `LEIBNIZ_SOURCE_V1\tapproved\nENTITY\tsource\t${category}\nENTITY\t${target}\tChannel\nFLOW\tsource\t${target}\t${rate}\tcontacts/s\tcontacts:1,time:-1\t1\t100\t200\t${evidence}\n`;
}
function pinned(content) {
  const original = file('original.tsv');
  const independent = file('pin.tsv');
  writeFileSync(original, content);
  writeFileSync(independent, content);
  return [original, independent];
}
function initial() {
  const state = file('initial.state');
  invoke('init', 'approved', state);
  const independent = file('initial.pin');
  copyFileSync(state, independent);
  return [state, independent];
}
function commit(previous, batch, sequence) {
  const out = file('new.state');
  invoke('append', ...previous, ...pinned(batch), String(sequence), out);
  const independentlyRetained = file('new.pin');
  copyFileSync(out, independentlyRetained);
  return [out, independentlyRetained];
}
function assertReject(args, output) {
  assert.throws(() => invoke(...args, output));
  assert.equal(existsSync(output), false, 'rejected batch created a usable new checkpoint');
}

test('two sequential LEIBNIZ source deliveries retain evidence and drive genuine GAUSS + Quantum', async () => {
  const first = commit(initial(), rawBatch(3, 'left', 'left-1'), 1);
  const second = commit(first, rawBatch(8, 'right', 'right-2'), 2);
  const archivePath = file('semantic.archive');
  invoke('extract', ...second, archivePath);
  const pinPath = file('independently-pinned-test-archive');
  copyFileSync(archivePath, pinPath);
  const result = await runMeasuredLinearBridge({
    binaryPath: bridge, archivePath, pinPath,
    problemId: 'sequential-measurements', asOfUtcMs: 150,
    coefficients: [[1, 0], [0, 2]], selections: [
      { fromEntity: 'source', toEntity: 'left', unit: 'contacts/s' },
      { fromEntity: 'source', toEntity: 'right', unit: 'contacts/s' },
    ],
  });
  assert.deepEqual(result.sourceRows.map((row) => row.value), [3, 8]);
  assert.deepEqual(result.sourceRows.map((row) => row.evidenceIds), [
    ['approved/left-1'], ['approved/right-2'],
  ]);
  assert.deepEqual(result.solution, [3, 4]);
  assert.equal(result.assurance, 'MEASURED_INPUT_NUMERIC_SOLVE_ONLY');
});

test('replay, skipped delivery, substituted prior checkpoint and batch are rejected', () => {
  const start = initial();
  const first = commit(start, rawBatch(3, 'left', 'left-1'), 1);
  for (const sequence of ['1', '3', '0']) {
    assertReject(['append', ...first, ...pinned(rawBatch(8, 'right', 'right-2')), sequence], file('reject.state'));
  }
  assertReject(['append', first[0], start[1], ...pinned(rawBatch(8, 'right', 'right-2')), '2'], file('reject.state'));
  const raw = pinned(rawBatch(8, 'right', 'right-2'));
  writeFileSync(raw[0], rawBatch(99, 'right', 'right-2'));
  assertReject(['append', ...first, ...raw, '2'], file('reject.state'));
});

test('historical evidence reuse, entity redefinition, and archive tampering fail closed', () => {
  const first = commit(initial(), rawBatch(3, 'left', 'left-1'), 1);
  assertReject(['append', ...first, ...pinned(rawBatch(8, 'right', 'left-1')), '2'], file('reject.state'));
  assertReject(['append', ...first, ...pinned(rawBatch(8, 'right', 'right-2', 'Impostor')), '2'], file('reject.state'));
  const tampered = file('changed.state');
  writeFileSync(tampered, Buffer.concat([readFileSync(first[0]), Buffer.from('extra')]));
  assertReject(['extract', tampered, first[1]], file('reject.archive'));
});
