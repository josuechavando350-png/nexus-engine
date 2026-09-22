// Only synthetic data. These tests neither authenticate an issuer nor attest
// the independent custody of witnesses or provide a trustworthy clock.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, linkSync, lstatSync, mkdtempSync, readdirSync,
  rmSync, statSync, symlinkSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bundle = process.env.LEIBNIZ_OPERATOR_BUNDLE;
const sequential = process.env.LEIBNIZ_SEQUENTIAL_SOURCE_BINARY;
const trusted = process.env.LEIBNIZ_TRUSTED_HEAD_BINARY;
const policyTool = process.env.LEIBNIZ_POLICY_WITNESS_BINARY;
if (![bundle, sequential, trusted, policyTool].every((item) => typeof item === 'string' && item.length)) {
  throw new Error('bundle and real test-only bootstrap executables required');
}
const binary = join(bundle, 'guarded_append');
const root = mkdtempSync(join(tmpdir(), 'leibniz-operator-bundle-'));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
const target = (name) => join(root, `${++counter}-${name}`);
const run = (exe, ...args) => execFileSync(exe, args, { encoding: 'utf8', timeout: 15_000 });
const policy = (status, revision = 3) =>
  `LEIBNIZ_SOURCE_POLICY_V1\tapproved\t${revision}\t${status}\t1\t2\t100\t200\n`;
const batch = 'LEIBNIZ_SOURCE_V1\tapproved\nENTITY\tsource\tOrganization\nENTITY\tleft\tChannel\nFLOW\tsource\tleft\t3\tcontacts/s\tcontacts:1,time:-1\t1\t100\t200\tevidence-1\n';
function pair(contents) {
  const value = target('value');
  const reference = target('pin');
  writeFileSync(value, contents);
  writeFileSync(reference, contents);
  return [value, reference];
}
function initial() {
  const state = target('initial');
  run(sequential, 'init', 'approved', state);
  const pin = target('state-pin');
  copyFileSync(state, pin);
  const head = target('state-head');
  run(trusted, 'propose', state, pin, head);
  return [state, pin, head];
}
function witness([value, pin]) {
  const head = target('policy-head');
  run(policyTool, 'propose', value, pin, head);
  return head;
}
const appendArgs = (state, input, policyPair, head) =>
  [...state, ...input, '1', ...policyPair, head, '150'];
function refused(...params) {
  const output = target('refused');
  assert.throws(() => run(binary, ...params, output));
  assert.equal(existsSync(output), false, 'refused operation left an output');
}

test('only the guarded executable and verifiable documentation ship', () => {
  assert.deepEqual(readdirSync(bundle).sort(), ['README.txt', 'SHA256SUMS', 'guarded_append']);
  assert.equal(statSync(binary).isFile(), true);
  assert.equal(statSync(binary).mode & 0o777, 0o700);
  execFileSync('sha256sum', ['--check', '--status', 'SHA256SUMS'], { cwd: bundle });
  for (const legacy of ['policy_source', 'sequential_source', 'trusted_head_source', 'policy_witness_source', 'ingest_authorized_source', 'gauss_bridge_export']) {
    assert.equal(existsSync(join(bundle, legacy)), false, `${legacy} found in operator distribution`);
  }
  assert.throws(() => run(binary, 'propose'));
});

test('the shipped Rust executable appends one batch and refuses output replacement', () => {
  const state = initial();
  const input = pair(batch);
  const current = pair(policy('ALLOW'));
  const head = witness(current);
  const output = target('accepted');
  assert.match(run(binary, ...appendArgs(state, input, current, head), output), /append accepted/u);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.throws(() => run(binary, ...appendArgs(state, input, current, head), output));
});

test('the latest revocation witness denies stale approval and current revocation', () => {
  const state = initial();
  const input = pair(batch);
  const oldAllow = pair(policy('ALLOW', 3));
  const revoked = pair(policy('REVOKED', 4));
  const latest = witness(revoked);
  refused(...appendArgs(state, input, oldAllow, latest));
  refused(...appendArgs(state, input, revoked, latest));
});

test('same-revision alternative and same-file policy pin are refused', () => {
  const state = initial();
  const input = pair(batch);
  const allowed = pair(policy('ALLOW', 4));
  const revoked = pair(policy('REVOKED', 4));
  refused(...appendArgs(state, input, allowed, witness(revoked)));
  refused(...appendArgs(state, input, [allowed[0], allowed[0]], witness(allowed)));
});

test('guarded descriptor opening refuses final symlinks, cross-role hardlinks and dangling output symlink', () => {
  const state = initial();
  const input = pair(batch);
  const allowed = pair(policy('ALLOW'));
  const head = witness(allowed);
  const inputLink = target('input-symlink');
  symlinkSync(input[0], inputLink);
  refused(...appendArgs(state, [inputLink, input[1]], allowed, head));
  const alias = target('policy-hardlink');
  linkSync(allowed[0], alias);
  refused(...appendArgs(state, input, [allowed[0], alias], head));
  const output = target('dangling-output');
  symlinkSync(target('nonexistent-target'), output);
  assert.throws(() => run(binary, ...appendArgs(state, input, allowed, head), output));
  assert.equal(lstatSync(output).isSymbolicLink(), true);
});

test('sparse oversized input fails before a checkpoint is created', () => {
  const state = initial();
  const input = pair(batch);
  const allowed = pair(policy('ALLOW'));
  const head = witness(allowed);
  const oversized = target('oversized-batch');
  writeFileSync(oversized, 'x');
  truncateSync(oversized, 83 * 1024 * 1024 + 1);
  refused(...appendArgs(state, [oversized, input[1]], allowed, head));
});
