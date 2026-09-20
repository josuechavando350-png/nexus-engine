#!/usr/bin/env node
// Detached operator review signature. Verifying a signature does NOT merge, deploy or authorize production.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLedgerRecord } from './evidence-ledger.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const NONCE = /^[a-f0-9]{32}$/u;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
const LIMIT = 32 * 1024;
const TOOL = 'AXIOMA_FORJA_DETACHED_REVIEW_SIGNATURE';
const ACTION = 'REVIEW_MERGE';
const fail = (message) => { throw new Error(`FORJA_REVIEW_SIGNATURE_ERROR: ${message}`); };
const check = (condition, message) => { if (!condition) fail(message); };
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function identity(record) {
  const id = record?.id;
  const revision = record?.payload?.sourceRevision;
  const tree = record?.payload?.walle?.sourceTree;
  check(DIGEST.test(id) && SHA.test(revision) && SHA.test(tree) &&
    revision === record?.payload?.consistency?.sourceRevision && revision === record?.payload?.walle?.sourceRevision,
  'record is not bound to one source revision');
  return { id, revision, tree };
}

function publicIdentity(publicKey) {
  const key = createPublicKey(publicKey);
  check(key.asymmetricKeyType === 'ed25519', 'trusted key must be Ed25519');
  return { key, fingerprint: hash(key.export({ type: 'spki', format: 'der' })) };
}

function signedBytes(fields) {
  return Buffer.from(`AXIOMA_FORJA_REVIEW_V1\n${JSON.stringify(fields)}`, 'utf8');
}

function checkedTime(issuedAt, expiresAt, now) {
  check(typeof issuedAt === 'string' && UTC.test(issuedAt) && !Number.isNaN(Date.parse(issuedAt)), 'invalid issue time');
  check(typeof expiresAt === 'string' && UTC.test(expiresAt) && !Number.isNaN(Date.parse(expiresAt)), 'invalid expiry time');
  const start = Date.parse(issuedAt);
  const end = Date.parse(expiresAt);
  check(end > start && end - start <= MAX_TTL_MS, 'signature expiry exceeds 24-hour bound');
  check(start <= now + MAX_CLOCK_SKEW_MS, 'signature issued in the future');
  check(end > now, 'review signature expired');
}

// Pure signer for explicit operator action and isolated tests. CLI verifies its
// ledger record and the Git source identity before loading a private key.
export function signReview({ record, privateKeyPem, now = Date.now(), nonce = randomBytes(16).toString('hex') }) {
  const source = identity(record);
  const privateKey = createPrivateKey(privateKeyPem);
  check(privateKey.asymmetricKeyType === 'ed25519', 'signing key must be Ed25519');
  check(NONCE.test(nonce), 'invalid review nonce');
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + MAX_TTL_MS).toISOString();
  // createPublicKey accepts the private KeyObject; pass its serialized public
  // representation to the verifier/fingerprint helper, not a public KeyObject.
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  const { fingerprint } = publicIdentity(publicPem);
  const fields = {
    schemaVersion: 1, tool: TOOL, action: ACTION, recordId: source.id,
    sourceRevision: source.revision, sourceTree: source.tree,
    issuedAt, expiresAt, nonce, publicKeySha256: fingerprint,
  };
  return { ...fields, signature: sign(null, signedBytes(fields), privateKey).toString('base64') };
}

export function verifyReview({ record, envelope, trustedPublicKeyPem, now = Date.now() }) {
  const source = identity(record);
  check(envelope && typeof envelope === 'object' && !Array.isArray(envelope), 'approval envelope is not an object');
  const { signature, ...fields } = envelope;
  const expectedKeys = ['schemaVersion', 'tool', 'action', 'recordId', 'sourceRevision', 'sourceTree',
    'issuedAt', 'expiresAt', 'nonce', 'publicKeySha256'];
  check(Object.keys(fields).length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(fields, key)),
    'unexpected review envelope fields');
  check(fields.schemaVersion === 1 && fields.tool === TOOL && fields.action === ACTION,
    'unsupported review action or schema');
  check(fields.recordId === source.id && fields.sourceRevision === source.revision && fields.sourceTree === source.tree,
    'review is bound to another record or revision');
  check(NONCE.test(fields.nonce), 'invalid nonce');
  check(DIGEST.test(fields.publicKeySha256), 'invalid public key fingerprint');
  checkedTime(fields.issuedAt, fields.expiresAt, now);
  const { key, fingerprint } = publicIdentity(trustedPublicKeyPem);
  check(fields.publicKeySha256 === fingerprint, 'signer not in the externally pinned trust key');
  check(typeof signature === 'string' && /^[A-Za-z0-9+/]{86}==$/u.test(signature), 'invalid signature encoding');
  check(verify(null, signedBytes(fields), key, Buffer.from(signature, 'base64')), 'review signature mismatch');
  return { schemaVersion: 1, tool: TOOL, status: 'SIGNATURE_MATCH_REVIEW_ONLY',
    recordId: source.id, sourceRevision: source.revision, publicKeySha256: fingerprint, expiresAt: fields.expiresAt,
    limitations: ['Signature authenticates possession of the configured key, not GitHub review identity or correctness of the report.',
      'No replay prevention across separate hosts. No merge, deployment or production approval is performed.'] };
}

function git(...args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
  check(!result.error && result.status === 0 && !result.signal, 'Git checkout identity unavailable');
  return result.stdout.trim();
}

function assertCurrentSource(record) {
  const source = identity(record);
  check(git('status', '--porcelain=v1', '--untracked-files=all') === '', 'checkout is dirty');
  check(git('rev-parse', 'HEAD') === source.revision && git('rev-parse', 'HEAD^{tree}') === source.tree,
    'checkout differs from reviewed source');
  check(!process.env.FORJA_SOURCE_SHA || process.env.FORJA_SOURCE_SHA === source.revision, 'workflow SHA mismatch');
}

async function boundedFile(path, { secret = false } = {}) {
  check(typeof path === 'string' && isAbsolute(path), 'file path must be absolute');
  const stat = await lstat(path);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= LIMIT, 'expected bounded regular file');
  if (secret) check((stat.mode & 0o077) === 0, 'private key permissions must exclude group and others');
  const bytes = await readFile(path);
  check(bytes.length <= LIMIT, 'file exceeds byte limit');
  return bytes;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 5 || !['sign-review', 'verify-review'].includes(args[0])) {
      fail('Usage: review-signature.mjs sign-review <abs-store> <sha256:id> <abs-private.pem> <abs-output.json> | verify-review <abs-store> <sha256:id> <abs-envelope.json> <abs-trusted-public.pem>');
    }
    const record = await readLedgerRecord({ storeRoot: args[1], id: args[2] });
    assertCurrentSource(record);
    if (args[0] === 'sign-review') {
      const key = await boundedFile(args[3], { secret: true });
      check(isAbsolute(args[4]), 'approval output path must be absolute');
      const envelope = signReview({ record, privateKeyPem: key });
      await writeFile(args[4], `${JSON.stringify(envelope)}\n`, { flag: 'wx', mode: 0o600 });
      process.stdout.write(`${JSON.stringify({ status: 'REVIEW_SIGNATURE_WRITTEN', recordId: record.id, outputPath: args[4] })}\n`);
    } else {
      const envelope = JSON.parse((await boundedFile(args[3])).toString('utf8'));
      const trustedPublicKeyPem = await boundedFile(args[4]);
      process.stdout.write(`${JSON.stringify(verifyReview({ record, envelope, trustedPublicKeyPem }))}\n`);
    }
  } catch (error) {
    console.error(`FORJA_REVIEW_SIGNATURE_ERROR: ${String(error?.message ?? error).replace(/[\r\n]+/gu, ' ').slice(0, 1200)}`);
    process.exitCode = 1;
  }
}
