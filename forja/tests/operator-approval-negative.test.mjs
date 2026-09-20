import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import test from 'node:test';
import { signApproval, verifyApproval } from '../operator-approval.mjs';

test('a signed challenge for a different job is rejected before filesystem inspection', async () => {
  const now = Date.now(), pair = generateKeyPairSync('ed25519');
  const id = randomUUID();
  const challenge = { schemaVersion: 1, purpose: 'MANUAL_PROMOTION_REVIEW', jobId: id,
    sourceRevision: 'f'.repeat(40), checkedSourceBytes: 5, evidenceDigest: 'e'.repeat(64),
    nonce: randomUUID(), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString() };
  const operatorId = 'operator-a';
  const envelope = signApproval(challenge, operatorId, pair.privateKey.export({type:'pkcs8',format:'pem'}).toString());
  const trustedOperators = { [operatorId]: pair.publicKey.export({type:'spki',format:'pem'}).toString() };
  await assert.rejects(verifyApproval({root:'/nonexistent',stateDir:'/nonexistent',id:randomUUID(),
    envelope,trustedOperators,now:now+1}), /different job/);
});
