// Synthetic acceptance ONLY. Proposed witnesses here are copied locally to
// simulate an external monotonic operator; this does NOT authenticate a source
// or establish tamper-proof witness storage in production.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { runMeasuredLinearBridge } from './gauss_measured_linear_bridge.mjs';

const guarded = process.env.LEIBNIZ_TRUSTED_HEAD_BINARY;
const sequential = process.env.LEIBNIZ_SEQUENTIAL_SOURCE_BINARY;
const bridge = process.env.LEIBNIZ_BRIDGE_EXPORT_BINARY;
if (![guarded, sequential, bridge].every((v) => typeof v === 'string' && v.length)) {
  throw new Error('real guarded, sequential and GAUSS bridge executables required');
}
const dir = mkdtempSync(join(tmpdir(), 'leibniz-trusted-head-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let number = 0;
const file = (name) => join(dir, `${++number}-${name}`);
const call = (binary, ...args) => execFileSync(binary, args, { encoding: 'utf8', timeout: 15_000 });
const batch = (rate, destination, evidence) =>
  `LEIBNIZ_SOURCE_V1\tapproved\nENTITY\tsource\tOrganization\nENTITY\t${destination}\tChannel\nFLOW\tsource\t${destination}\t${rate}\tcontacts/s\tcontacts:1,time:-1\t1\t100\t200\t${evidence}\n`;
function pair(text) {
  const original = file('data');
  const pin = file('reference');
  writeFileSync(original, text);
  writeFileSync(pin, text);
  return [original, pin];
}
function init() {
  const state = file('initial.state');
  call(sequential, 'init', 'approved', state);
  const pin = file('initial.pin');
  copyFileSync(state, pin);
  return [state, pin];
}
function proposedHead([state, pin]) {
  const proposal = file('head-proposal');
  call(guarded, 'propose', state, pin, proposal);
  return proposal;
}
function appendWithHead(previous, head, input, sequence) {
  const output = file('checkpoint');
  call(guarded, 'append', ...previous, head, ...pair(input), String(sequence), output);
  const pinned = file('checkpoint-pin');
  copyFileSync(output, pinned);
  return [output, pinned];
}
function reject(...args) {
  const output = file('rejected-output');
  assert.throws(() => call(guarded, ...args, output));
  assert.equal(existsSync(output), false, 'rejection left a usable checkpoint');
}

test('two witnessed batches give GAUSS two preserved rates and Quantum receipt', async () => {
  const start = init();
  const one = appendWithHead(start, proposedHead(start), batch(3, 'left', 'left-1'), 1);
  const two = appendWithHead(one, proposedHead(one), batch(8, 'right', 'right-2'), 2);
  const archivePath = file('archive');
  call(guarded, 'extract', ...two, proposedHead(two), archivePath);
  const pinPath = file('archive-pin');
  copyFileSync(archivePath, pinPath);
  const result = await runMeasuredLinearBridge({
    binaryPath: bridge, archivePath, pinPath, problemId: 'witnessed-sequence', asOfUtcMs: 150,
    coefficients: [[1, 0], [0, 2]], selections: [
      { fromEntity: 'source', toEntity: 'left', unit: 'contacts/s' },
      { fromEntity: 'source', toEntity: 'right', unit: 'contacts/s' },
    ],
  });
  assert.deepEqual(result.sourceRows.map((row) => row.value), [3, 8]);
  assert.deepEqual(result.sourceRows.map((row) => row.evidenceIds), [['approved/left-1'], ['approved/right-2']]);
  assert.deepEqual(result.solution, [3, 4]);
  assert.match(result.quantumReceiptSha256, /^sha256:[a-f0-9]{64}$/u);
});

test('old checkpoint AND matching old pin fail when independent head stays current', () => {
  const start = init();
  const first = appendWithHead(start, proposedHead(start), batch(3, 'left', 'left-1'), 1);
  const second = appendWithHead(first, proposedHead(first), batch(8, 'right', 'right-2'), 2);
  const latest = proposedHead(second);
  // The attacker replaced BOTH local files with identical valid old bytes.
  assert.deepEqual(readFileSync(first[0]), readFileSync(first[1]));
  reject('append', ...first, latest, ...pair(batch(9, 'other', 'other-3')), '2');
  reject('extract', ...first, latest);
});

test('cross-source witness, corrupt head, and modified reference are rejected', () => {
  const start = init();
  const latest = proposedHead(start);
  const forged = file('forged-head');
  writeFileSync(forged, 'LEIBNIZ_TRUSTED_HEAD_V1\tother\t0\n');
  reject('append', ...start, forged, ...pair(batch(3, 'left', 'left-1')), '1');
  writeFileSync(forged, 'LEIBNIZ_TRUSTED_HEAD_V1\tapproved\t00\n');
  reject('append', ...start, forged, ...pair(batch(3, 'left', 'left-1')), '1');
  const pin = file('wrong-reference');
  writeFileSync(pin, Buffer.concat([readFileSync(start[0]), Buffer.from('extra')]));
  reject('append', start[0], pin, latest, ...pair(batch(3, 'left', 'left-1')), '1');
});
