// Synthetic operator-controlled policies and source records. No test here
// proves authenticity of the policy issuer, independent custody or live data.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runMeasuredLinearBridge } from './gauss_measured_linear_bridge.mjs';

const guarded = process.env.LEIBNIZ_TRUSTED_HEAD_BINARY;
const sequential = process.env.LEIBNIZ_SEQUENTIAL_SOURCE_BINARY;
const bridge = process.env.LEIBNIZ_BRIDGE_EXPORT_BINARY;
if (![guarded, sequential, bridge].every((p) => typeof p === 'string' && p.length)) {
  throw new Error('real policy, source and bridge executables required');
}
const policyCli = join(dirname(guarded), 'policy_source');
const root = mkdtempSync(join(tmpdir(), 'leibniz-policy-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const path = (label) => join(root, `${++n}-${label}`);
const call = (binary, ...args) => execFileSync(binary, args, { encoding: 'utf8', timeout: 15_000 });
const source = (rate, destination, evidence) =>
  `LEIBNIZ_SOURCE_V1\tapproved\nENTITY\tsource\tOrganization\nENTITY\t${destination}\tChannel\nFLOW\tsource\t${destination}\t${rate}\tcontacts/s\tcontacts:1,time:-1\t1\t100\t200\t${evidence}\n`;
const policy = (status = 'ALLOW', revision = 3, from = 100, to = 200) =>
  `LEIBNIZ_SOURCE_POLICY_V1\tapproved\t${revision}\t${status}\t1\t2\t${from}\t${to}\n`;
function pair(contents) {
  const sourcePath = path('source');
  const pin = path('pin');
  writeFileSync(sourcePath, contents);
  writeFileSync(pin, contents);
  return [sourcePath, pin];
}
function init() {
  const state = path('init');
  call(sequential, 'init', 'approved', state);
  const pin = path('init-pin');
  copyFileSync(state, pin);
  const head = path('head');
  call(guarded, 'propose', state, pin, head);
  return [state, pin, head];
}
function args(state, statePin, head, inputPair, seq, policyPair, floor = 3, asOf = 150) {
  return ['append', state, statePin, head, ...inputPair, String(seq), ...policyPair, String(floor), String(asOf)];
}
function reject(...argumentsExceptOutput) {
  const output = path('rejected');
  assert.throws(() => call(policyCli, ...argumentsExceptOutput, output));
  assert.equal(existsSync(output), false, 'rejected policy produced a usable checkpoint');
}

test('active policy gates two real Rust batches and their archive reaches GAUSS plus Quantum', async () => {
  const [state, statePin, head] = init();
  const first = path('first');
  call(policyCli, ...args(state, statePin, head, pair(source(3, 'left', 'left-1')), 1, pair(policy())), first);
  const firstPin = path('first-pin');
  copyFileSync(first, firstPin);
  const firstHead = path('first-head');
  call(guarded, 'propose', first, firstPin, firstHead);
  const second = path('second');
  call(policyCli, ...args(first, firstPin, firstHead, pair(source(8, 'right', 'right-2')), 2, pair(policy())), second);
  const secondPin = path('second-pin');
  copyFileSync(second, secondPin);
  const secondHead = path('second-head');
  call(guarded, 'propose', second, secondPin, secondHead);
  const archive = path('archive');
  call(guarded, 'extract', second, secondPin, secondHead, archive);
  const archivePin = path('archive-pin');
  copyFileSync(archive, archivePin);
  const result = await runMeasuredLinearBridge({
    binaryPath: bridge, archivePath: archive, pinPath: archivePin,
    problemId: 'consent-gated-measurements', asOfUtcMs: 150,
    coefficients: [[1, 0], [0, 2]], selections: [
      { fromEntity: 'source', toEntity: 'left', unit: 'contacts/s' },
      { fromEntity: 'source', toEntity: 'right', unit: 'contacts/s' },
    ],
  });
  assert.deepEqual(result.sourceRows.map((row) => row.value), [3, 8]);
  assert.deepEqual(result.solution, [3, 4]);
  assert.match(result.quantumReceiptSha256, /^sha256:[a-f0-9]{64}$/u);
});

test('revocation and stale policy revision reject the batch without checkpoint output', () => {
  const state = init();
  const input = pair(source(3, 'left', 'left-1'));
  reject(...args(...state, input, 1, pair(policy('REVOKED'))));
  reject(...args(...state, input, 1, pair(policy('ALLOW', 2)), 3));
  reject(...args(...state, input, 1, pair(policy()), 4));
});

test('policy and measurement expiry, wrong source and modified policy pin all reject', () => {
  const state = init();
  const input = pair(source(3, 'left', 'left-1'));
  reject(...args(...state, input, 1, pair(policy()), 3, 200));
  reject(...args(...state, input, 1, pair(policy('ALLOW', 3, 100, 300)), 3, 200));
  const wrong = pair(policy().replace('\tapproved\t', '\tunknown\t'));
  reject(...args(...state, input, 1, wrong));
  const [p, pin] = pair(policy());
  writeFileSync(pin, policy('REVOKED'));
  reject(...args(...state, input, 1, [p, pin]));
});

test('policy pin hardlink and wrong historical witness are refused', () => {
  const state = init();
  const input = pair(source(3, 'left', 'left-1'));
  const [p] = pair(policy());
  const hardlink = path('policy-hardlink');
  linkSync(p, hardlink);
  reject(...args(...state, input, 1, [p, hardlink]));
  const unrelated = path('bad-head');
  writeFileSync(unrelated, 'LEIBNIZ_TRUSTED_HEAD_V1\tapproved\t0\n');
  reject(...args(state[0], state[1], unrelated, input, 1, pair(policy())));
});
