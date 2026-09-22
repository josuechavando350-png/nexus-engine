// Synthetic records and locally proposed witnesses ONLY. Their independent
// custody, authentication and monotonic publication are NOT tested here.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMeasuredLinearBridge } from './gauss_measured_linear_bridge.mjs';

const witnessCli = process.env.LEIBNIZ_POLICY_WITNESS_BINARY;
const checkpointCli = process.env.LEIBNIZ_TRUSTED_HEAD_BINARY;
const sequentialCli = process.env.LEIBNIZ_SEQUENTIAL_SOURCE_BINARY;
const bridgeCli = process.env.LEIBNIZ_BRIDGE_EXPORT_BINARY;
if (![witnessCli, checkpointCli, sequentialCli, bridgeCli].every((p) => typeof p === 'string' && p.length)) {
  throw new Error('real LEIBNIZ and GAUSS/Quantum binaries must be supplied');
}
const root = mkdtempSync(join(tmpdir(), 'leibniz-policy-witness-'));
after(() => rmSync(root, { recursive: true, force: true }));
let serial = 0;
const file = (label) => join(root, `${++serial}-${label}`);
const run = (binary, ...args) => execFileSync(binary, args, { encoding: 'utf8', timeout: 15_000 });
const source = (rate, destination, evidence) =>
  `LEIBNIZ_SOURCE_V1\tapproved\nENTITY\tsource\tOrganization\nENTITY\t${destination}\tChannel\nFLOW\tsource\t${destination}\t${rate}\tcontacts/s\tcontacts:1,time:-1\t1\t100\t200\t${evidence}\n`;
const policy = (revision, status = 'ALLOW') =>
  `LEIBNIZ_SOURCE_POLICY_V1\tapproved\t${revision}\t${status}\t1\t2\t100\t200\n`;
function pair(text) {
  const value = file('value');
  const pin = file('pin');
  writeFileSync(value, text);
  writeFileSync(pin, text);
  return [value, pin];
}
function init() {
  const state = file('initial.state');
  run(sequentialCli, 'init', 'approved', state);
  const pin = file('initial.pin');
  copyFileSync(state, pin);
  const head = file('state.head');
  run(checkpointCli, 'propose', state, pin, head);
  return [state, pin, head];
}
function proposePolicy(policyPair) {
  const head = file('policy.head');
  run(witnessCli, 'propose', ...policyPair, head);
  return head;
}
function append(previous, batchPair, seq, policyPair, policyHead) {
  const output = file('next.state');
  run(witnessCli, 'append', ...previous, ...batchPair, String(seq), ...policyPair, policyHead, '150', output);
  const pin = file('next.pin');
  copyFileSync(output, pin);
  const head = file('next.head');
  run(checkpointCli, 'propose', output, pin, head);
  return [output, pin, head];
}
function reject(previous, batchPair, seq, policyPair, head) {
  const output = file('rejected.state');
  assert.throws(() => run(witnessCli, 'append', ...previous, ...batchPair, String(seq), ...policyPair, head, '150', output));
  assert.equal(existsSync(output), false, 'invalid policy left a usable checkpoint');
}

test('current policy witness admits two source batches through real GAUSS and Quantum', async () => {
  const permission = pair(policy(3));
  const permissionHead = proposePolicy(permission);
  const first = append(init(), pair(source(3, 'left', 'left-1')), 1, permission, permissionHead);
  const second = append(first, pair(source(8, 'right', 'right-2')), 2, permission, permissionHead);
  const archive = file('archive');
  run(checkpointCli, 'extract', ...second, archive);
  const archivePin = file('archive.pin');
  copyFileSync(archive, archivePin);
  const report = await runMeasuredLinearBridge({
    binaryPath: bridgeCli, archivePath: archive, pinPath: archivePin,
    problemId: 'policy-witness-consent', asOfUtcMs: 150,
    coefficients: [[1, 0], [0, 2]], selections: [
      { fromEntity: 'source', toEntity: 'left', unit: 'contacts/s' },
      { fromEntity: 'source', toEntity: 'right', unit: 'contacts/s' },
    ],
  });
  assert.deepEqual(report.sourceRows.map((row) => row.value), [3, 8]);
  assert.deepEqual(report.solution, [3, 4]);
  assert.match(report.quantumReceiptSha256, /^sha256:[a-f0-9]{64}$/u);
});

test('old allowed policy and both matching old copies fail against current revoked witness', () => {
  const state = init();
  const batch = pair(source(3, 'left', 'left-1'));
  const oldPermit = pair(policy(3));
  const revoked = pair(policy(4, 'REVOKED'));
  const latest = proposePolicy(revoked);
  reject(state, batch, 1, oldPermit, latest);
  reject(state, batch, 1, revoked, latest);
});

test('same revision alternate policy, stale head and mismatched pin all fail without output', () => {
  const state = init();
  const batch = pair(source(3, 'left', 'left-1'));
  const permit = pair(policy(3));
  const revokedSameRevision = pair(policy(3, 'REVOKED'));
  const latest = proposePolicy(revokedSameRevision);
  reject(state, batch, 1, permit, latest);
  const oldHead = proposePolicy(permit);
  const rotated = pair(policy(4));
  reject(state, batch, 1, rotated, oldHead);
  const [p, pin] = permit;
  writeFileSync(pin, policy(4));
  reject(state, batch, 1, [p, pin], oldHead);
  const malformed = file('forged.head');
  writeFileSync(malformed, 'LEIBNIZ_POLICY_HEAD_V1\tapproved\t3\t0\n');
  reject(state, batch, 1, permit, malformed);
});
