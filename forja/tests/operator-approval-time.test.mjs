import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';
import { signApproval } from '../operator-approval.mjs';

test('malformed or overly long approval lifetime is rejected at signing', () => {
  const keys = generateKeyPairSync('ed25519');
  const key = keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
  const now = new Date('2026-09-20T12:00:00.000Z');
  const input = {schemaVersion:1,purpose:'MANUAL_PROMOTION_REVIEW',jobId:randomUUID(),
    sourceRevision:'a'.repeat(40),checkedSourceBytes:5,evidenceDigest:'b'.repeat(64),
    nonce:randomUUID(),issuedAt:now.toISOString(),expiresAt:new Date(now.getTime()+16*60000).toISOString()};
  assert.throws(()=>signApproval(input,'operator-1',key),/validity window/);
});
