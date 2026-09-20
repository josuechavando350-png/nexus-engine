import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { signReview, verifyReview } from '../review-signature.mjs';

const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const sha = 'a'.repeat(40);
function record() {
  return { id: `sha256:${'c'.repeat(64)}`, payload: {
    sourceRevision: sha,
    consistency: { sourceRevision: sha },
    walle: { sourceRevision: sha, sourceTree: 'b'.repeat(40) },
  } };
}
function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) };
}
function prepared() {
  const identity = keys();
  const value = record();
  const envelope = signReview({ record: value, privateKeyPem: identity.privateKeyPem, now: NOW,
    nonce: 'd'.repeat(32) });
  return { ...identity, record: value, envelope };
}

test('accepts the correctly pinned Ed25519 signature for one bounded review', () => {
  const a = prepared();
  const result = verifyReview({ record: a.record, envelope: a.envelope,
    trustedPublicKeyPem: a.publicKeyPem, now: NOW });
  assert.equal(result.status, 'SIGNATURE_MATCH_REVIEW_ONLY');
  assert.equal(result.sourceRevision, sha);
  assert.equal(result.recordId, a.record.id);
});

test('rejects a signature by a different public key even with the same record', () => {
  const a = prepared();
  const other = keys();
  assert.throws(() => verifyReview({ record: a.record, envelope: a.envelope,
    trustedPublicKeyPem: other.publicKeyPem, now: NOW }), /signer not in/);
});

test('rejects a forged signature with the trusted public key identifier', () => {
  const a = prepared();
  const other = keys();
  const forged = signReview({ record: a.record, privateKeyPem: other.privateKeyPem, now: NOW, nonce: 'd'.repeat(32) });
  forged.publicKeySha256 = a.envelope.publicKeySha256;
  assert.throws(() => verifyReview({ record: a.record, envelope: forged,
    trustedPublicKeyPem: a.publicKeyPem, now: NOW }), /signature mismatch/);
});

test('rejects an envelope altered after signing', () => {
  const a = prepared();
  a.envelope.nonce = 'e'.repeat(32);
  assert.throws(() => verifyReview({ record: a.record, envelope: a.envelope,
    trustedPublicKeyPem: a.publicKeyPem, now: NOW }), /signature mismatch/);
});

test('rejects mismatched record identity and source revision', () => {
  const a = prepared();
  a.record.id = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => verifyReview({ record: a.record, envelope: a.envelope,
    trustedPublicKeyPem: a.publicKeyPem, now: NOW }), /another record/);
  const b = prepared();
  b.record.payload.sourceRevision = 'f'.repeat(40);
  assert.throws(() => verifyReview({ record: b.record, envelope: b.envelope,
    trustedPublicKeyPem: b.publicKeyPem, now: NOW }), /one source revision/);
});

test('rejects an expired signature and an issued-in-future signature', () => {
  const a = prepared();
  assert.throws(() => verifyReview({ record: a.record, envelope: a.envelope,
    trustedPublicKeyPem: a.publicKeyPem, now: NOW + 24 * 60 * 60 * 1000 }), /expired/);
  assert.throws(() => verifyReview({ record: a.record, envelope: a.envelope,
    trustedPublicKeyPem: a.publicKeyPem, now: NOW - 10 * 60 * 1000 }), /issued in the future/);
});

test('rejects a broader action or excessive expiry even if the signature is otherwise valid', () => {
  const a = prepared();
  a.envelope.action = 'DEPLOY_PRODUCTION';
  assert.throws(() => verifyReview({ record: a.record, envelope: a.envelope,
    trustedPublicKeyPem: a.publicKeyPem, now: NOW }), /unsupported review action/);
  const b = prepared();
  b.envelope.expiresAt = new Date(NOW + 48 * 60 * 60 * 1000).toISOString();
  assert.throws(() => verifyReview({ record: b.record, envelope: b.envelope,
    trustedPublicKeyPem: b.publicKeyPem, now: NOW }), /24-hour bound/);
});

test('rejects extra fields, malformed signatures and unsupported keys', () => {
  const a = prepared();
  a.envelope.unreviewed = true;
  assert.throws(() => verifyReview({ record: a.record, envelope: a.envelope,
    trustedPublicKeyPem: a.publicKeyPem, now: NOW }), /unexpected review envelope/);
  const b = prepared();
  b.envelope.signature = 'not a signature';
  assert.throws(() => verifyReview({ record: b.record, envelope: b.envelope,
    trustedPublicKeyPem: b.publicKeyPem, now: NOW }), /signature encoding/);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  assert.throws(() => signReview({ record: record(), privateKeyPem: privateKey, now: NOW }), /must be Ed25519/);
});
