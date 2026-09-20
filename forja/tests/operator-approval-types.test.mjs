import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';
import { signApproval } from '../operator-approval.mjs';

test('only Ed25519 signatures are accepted', () => {
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
  const now=Date.now();
  const challenge={schemaVersion:1,purpose:'MANUAL_PROMOTION_REVIEW',jobId:randomUUID(),
    sourceRevision:'a'.repeat(40),checkedSourceBytes:5,evidenceDigest:'b'.repeat(64),
    nonce:randomUUID(),issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+60000).toISOString()};
  assert.throws(()=>signApproval(challenge,'operator',rsa.privateKey.export({type:'pkcs8',format:'pem'}).toString()),/Ed25519/);
});
