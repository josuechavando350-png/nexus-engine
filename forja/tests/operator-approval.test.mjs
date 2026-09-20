import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';
import { signApproval, verifySignature } from '../operator-approval.mjs';
const key = generateKeyPairSync('ed25519');
const trusted = { 'reviewer-1': key.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const privateKey = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const time = Date.parse('2026-09-20T00:00:00.000Z');
function challenge() { return { schemaVersion: 1, purpose: 'MANUAL_PROMOTION_REVIEW',
  jobId: randomUUID(), sourceRevision: 'a'.repeat(40), checkedSourceBytes: 5,
  evidenceDigest: 'b'.repeat(64), nonce: randomUUID(), issuedAt: new Date(time).toISOString(),
  expiresAt: new Date(time + 600000).toISOString() }; }
function approval() { return signApproval(challenge(), 'reviewer-1', privateKey); }
test('Ed25519 approval is bound to source, job, evidence, nonce, purpose, expiry and operator', () => {
  const signed = approval();
  assert.equal(verifySignature(signed, trusted, time + 1), true);
  for (const key of ['jobId','sourceRevision','evidenceDigest','nonce','purpose','expiresAt','checkedSourceBytes']) {
    const damaged = structuredClone(signed);
    damaged.challenge[key] = key === 'checkedSourceBytes' ? 7 : key === 'expiresAt' ? new Date(time + 550000).toISOString() :
      key === 'purpose' ? 'DEPLOY' : key === 'sourceRevision' ? 'c'.repeat(40) : key === 'evidenceDigest' ? 'c'.repeat(64) : randomUUID();
    assert.throws(() => verifySignature(damaged, trusted, time + 1), /FORJA_APPROVAL/);
  }
  const renamed = structuredClone(signed); renamed.operatorId = 'reviewer-2';
  assert.throws(() => verifySignature(renamed, { ...trusted, 'reviewer-2': trusted['reviewer-1'] }, time + 1), /signature/);
});
test('rejects expiration, not-yet-valid requests, extra fields and untrusted keys', () => {
  const signed = approval();
  assert.throws(() => verifySignature(signed, trusted, time - 1), /not currently valid/);
  assert.throws(() => verifySignature(signed, trusted, time + 600000), /not currently valid/);
  assert.throws(() => verifySignature(signed, {}, time + 1), /not trusted/);
  const extra = structuredClone(signed); extra.challenge.admin = true;
  assert.throws(() => verifySignature(extra, trusted, time + 1), /invalid approval challenge/);
  const extension = structuredClone(signed); extension.extra = 'ignored';
  assert.throws(() => verifySignature(extension, trusted, time + 1), /invalid signed approval/);
  const oversized = structuredClone(signed); oversized.challenge.expiresAt = new Date(time + 3600000).toISOString();
  assert.throws(() => signApproval(oversized.challenge, 'reviewer-1', privateKey), /validity window/);
});
test('a second Ed25519 key cannot impersonate the trusted operator', () => {
  const other = generateKeyPairSync('ed25519');
  const forged = signApproval(challenge(), 'reviewer-1', other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  assert.throws(() => verifySignature(forged, trusted, time + 1), /signature/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => signApproval(challenge(), 'reviewer-1', rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()), /Ed25519/);
});
