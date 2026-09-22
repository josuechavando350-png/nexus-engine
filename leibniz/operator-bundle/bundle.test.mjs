// This checks executable distribution and the REAL Rust guarded CLI using
// synthetic inputs. It does not authenticate any policy issuer or custodian.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bundle = process.env.LEIBNIZ_OPERATOR_BUNDLE;
const sequential = process.env.LEIBNIZ_SEQUENTIAL_SOURCE_BINARY;
const trusted = process.env.LEIBNIZ_TRUSTED_HEAD_BINARY;
const policyTool = process.env.LEIBNIZ_POLICY_WITNESS_BINARY;
if (![bundle, sequential, trusted, policyTool].every((item) => typeof item === 'string' && item.length)) {
  throw new Error('bundle plus three real test-only bootstrap binaries required');
}
const soleBinary = join(bundle, 'guarded_append');
const root = mkdtempSync(join(tmpdir(), 'leibniz-operator-bundle-'));
after(() => rmSync(root, { recursive: true, force: true }));
let count = 0;
const newPath = (name) => join(root, `${++count}-${name}`);
const run = (binary, ...args) => execFileSync(binary, args, { encoding: 'utf8', timeout: 15_000 });
function files(bytes) {
  const value = newPath('input');
  const pin = newPath('reference');
  writeFileSync(value, bytes);
  writeFileSync(pin, bytes);
  return [value, pin];
}
function bootstrap() {
  const state = newPath('state');
  run(sequential, 'init', 'approved', state);
  const pin = newPath('state-pin');
  copyFileSync(state, pin);
  const head = newPath('state-head');
  run(trusted, 'propose', state, pin, head);
  return [state, pin, head];
}
const batch = 'LEIBNIZ_SOURCE_V1\tapproved\nENTITY\tsource\tOrganization\nENTITY\tleft\tChannel\nFLOW\tsource\tleft\t3\tcontacts/s\tcontacts:1,time:-1\t1\t100\t200\tevidence-1\n';
const policy = (status, revision = 3) =>
  `LEIBNIZ_SOURCE_POLICY_V1\tapproved\t${revision}\t${status}\t1\t2\t100\t200\n`;
function witness(policyPair) {
  const head = newPath('policy-head');
  run(policyTool, 'propose', ...policyPair, head);
  return head;
}
function args(state, input, policyPair, policyHead, output) {
  return [...state, ...input, '1', ...policyPair, policyHead, '150', output];
}
function refused(...inputArgs) {
  const output = newPath('refused-checkpoint');
  assert.throws(() => run(soleBinary, ...inputArgs, output));
  assert.equal(existsSync(output), false, 'rejected request created a checkpoint');
}

test('distribution contains exactly the append-only binary, documentation and checksums', () => {
  assert.deepEqual(readdirSync(bundle).sort(), ['README.txt', 'SHA256SUMS', 'guarded_append']);
  assert.equal(statSync(soleBinary).isFile(), true);
  assert.equal((statSync(soleBinary).mode & 0o777), 0o700);
  run('sha256sum', '--check', '--status', join(bundle, 'SHA256SUMS'));
  for (const forbidden of [
    'policy_source', 'sequential_source', 'trusted_head_source',
    'policy_witness_source', 'ingest_authorized_source', 'gauss_bridge_export',
  ]) {
    assert.equal(existsSync(join(bundle, forbidden)), false, `${forbidden} escaped into operator bundle`);
  }
  assert.throws(() => run(soleBinary, 'propose'));
});

test('shipped Rust binary accepts current witnessed policy and rejects a replayed output', () => {
  const state = bootstrap();
  const input = files(batch);
  const current = files(policy('ALLOW'));
  const head = witness(current);
  const output = newPath('accepted-checkpoint');
  assert.match(run(soleBinary, ...args(state, input, current, head, output)), /append accepted/u);
  assert.equal(existsSync(output), true);
  assert.equal((statSync(output).mode & 0o777), 0o600);
  assert.throws(() => run(soleBinary, ...args(state, input, current, head, output)), /cannot create new checkpoint/u);
});

test('latest revoked witness refuses old ALLOW policy even when its separate pin matches', () => {
  const state = bootstrap();
  const input = files(batch);
  const oldAllow = files(policy('ALLOW', 3));
  const revoked = files(policy('REVOKED', 4));
  const latestHead = witness(revoked);
  const oldHead = witness(oldAllow);
  refused(...args(state, input, oldAllow, latestHead, '').slice(0, -1));
  refused(...args(state, input, revoked, latestHead, '').slice(0, -1));
  // An old witness is syntactically valid, but cannot be trusted as latest:
  // the separate external authority must prevent its substitution.
  assert.notEqual(oldHead, latestHead);
});

test('same-revision alternative permission cannot replace the exact witnessed bytes', () => {
  const state = bootstrap();
  const input = files(batch);
  const alternate = files(policy('ALLOW', 4));
  const revoked = files(policy('REVOKED', 4));
  refused(...args(state, input, alternate, witness(revoked), '').slice(0, -1));
  const [policyFile] = alternate;
  refused(...args(state, input, [policyFile, policyFile], witness(alternate), '').slice(0, -1));
});
