#!/usr/bin/env node
// Offline human approval of a specific SHA-bound, independently inspected FORJA job.
// This gate NEVER performs a deployment or grants autonomous execution rights.
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectJob } from './state-inspector.mjs';

const SHA = /^[a-f0-9]{40}$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const OPERATOR = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const STEPS = ['job', 'inventory', 'audit', 'contract', 'consistency'];
const MAX = 2 * 1024 * 1024;
const WINDOW = 15 * 60 * 1000;
function demand(ok, reason) { if (!ok) throw new Error(`FORJA_APPROVAL: ${reason}`); }
function exactKeys(obj, names) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) &&
    Object.keys(obj).length === names.length && names.every((name) => Object.hasOwn(obj, name));
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function boundedFile(path) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    demand(stat.isFile() && stat.size >= 2 && stat.size <= MAX, 'unsafe or oversized evidence');
    const bytes = await fd.readFile();
    demand(bytes.length === stat.size && bytes.length <= MAX, 'evidence changed while reading');
    return bytes;
  } finally { await fd.close(); }
}
function canonical(challenge) {
  const names = ['schemaVersion','purpose','jobId','sourceRevision','checkedSourceBytes',
    'evidenceDigest','nonce','issuedAt','expiresAt'];
  demand(exactKeys(challenge, names) && challenge.schemaVersion === 1 &&
    challenge.purpose === 'MANUAL_PROMOTION_REVIEW' && ID.test(challenge.jobId) &&
    SHA.test(challenge.sourceRevision) && Number.isSafeInteger(challenge.checkedSourceBytes) &&
    challenge.checkedSourceBytes > 0 && /^[a-f0-9]{64}$/.test(challenge.evidenceDigest) &&
    ID.test(challenge.nonce) && typeof challenge.issuedAt === 'string' &&
    typeof challenge.expiresAt === 'string', 'invalid approval challenge');
  const issued = Date.parse(challenge.issuedAt), expires = Date.parse(challenge.expiresAt);
  demand(Number.isFinite(issued) && Number.isFinite(expires) &&
    new Date(issued).toISOString() === challenge.issuedAt &&
    new Date(expires).toISOString() === challenge.expiresAt &&
    expires > issued && expires - issued <= WINDOW, 'invalid approval validity window');
  return Buffer.from(`AXIOMA_FORJA_OPERATOR_APPROVAL_V1\n${JSON.stringify(names.map((key) => challenge[key]))}`, 'utf8');
}
async function inspectedSnapshot({ root, stateDir, id }) {
  const inspection = await inspectJob({ root, stateDir, id });
  demand(inspection.status === 'PASS' && inspection.jobStatus === 'SUCCEEDED' &&
    inspection.verifiedReports === 4 && Number.isSafeInteger(inspection.checkedSourceBytes) &&
    inspection.checkedSourceBytes > 0 && SHA.test(inspection.sourceRevision),
  'job does not have fully verified successful evidence');
  const state = await realpath(stateDir);
  const files = [];
  for (const name of STEPS) {
    const path = name === 'job' ? join(state, 'jobs', `${id}.json`) :
      join(state, 'artifacts', id, `${name}.json`);
    files.push([name, hash(await boundedFile(path))]);
  }
  const after = await inspectJob({ root, stateDir, id });
  demand(after.status === 'PASS' && after.jobStatus === 'SUCCEEDED' &&
    after.sourceRevision === inspection.sourceRevision &&
    after.checkedSourceBytes === inspection.checkedSourceBytes, 'job changed during inspection');
  return { sourceRevision: inspection.sourceRevision, checkedSourceBytes: inspection.checkedSourceBytes,
    evidenceDigest: hash(Buffer.from(JSON.stringify(files), 'utf8')) };
}
export async function challengeForJob({ root, stateDir, id, now = Date.now(), minutes = 10 }) {
  demand(typeof root === 'string' && isAbsolute(root) && typeof stateDir === 'string' && isAbsolute(stateDir) &&
    typeof id === 'string' && ID.test(id) && Number.isSafeInteger(now) &&
    Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 15, 'invalid challenge inputs');
  const snapshot = await inspectedSnapshot({ root, stateDir, id });
  const challenge = { schemaVersion: 1, purpose: 'MANUAL_PROMOTION_REVIEW', jobId: id,
    ...snapshot, nonce: randomUUID(), issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + minutes * 60000).toISOString() };
  canonical(challenge);
  return challenge;
}
function signedMessage(challenge, operatorId) {
  demand(typeof operatorId === 'string' && OPERATOR.test(operatorId), 'invalid operator id');
  return Buffer.concat([Buffer.from(`OPERATOR:${operatorId}\n`, 'utf8'), canonical(challenge)]);
}
export function signApproval(challenge, operatorId, privateKeyPem) {
  const message = signedMessage(challenge, operatorId);
  const key = createPrivateKey(privateKeyPem);
  demand(key.asymmetricKeyType === 'ed25519', 'Ed25519 private key required');
  return { schemaVersion: 1, operatorId, challenge,
    signature: sign(null, message, key).toString('base64') };
}
export function verifySignature(envelope, trustedOperators, now = Date.now()) {
  demand(exactKeys(envelope, ['schemaVersion','operatorId','challenge','signature']) &&
    envelope.schemaVersion === 1 && typeof envelope.operatorId === 'string' &&
    OPERATOR.test(envelope.operatorId) && typeof envelope.signature === 'string' &&
    /^[A-Za-z0-9+/]{86}==$/.test(envelope.signature), 'invalid signed approval');
  const message = signedMessage(envelope.challenge, envelope.operatorId);
  demand(Number.isSafeInteger(now) && now >= Date.parse(envelope.challenge.issuedAt) &&
    now < Date.parse(envelope.challenge.expiresAt), 'approval is not currently valid');
  demand(trustedOperators && Object.hasOwn(trustedOperators, envelope.operatorId) &&
    typeof trustedOperators[envelope.operatorId] === 'string', 'operator is not trusted');
  const key = createPublicKey(trustedOperators[envelope.operatorId]);
  demand(key.asymmetricKeyType === 'ed25519' &&
    verify(null, message, key, Buffer.from(envelope.signature, 'base64')),
  'operator signature does not verify');
  return true;
}
export async function verifyApproval({ root, stateDir, id, envelope, trustedOperators, now = Date.now() }) {
  verifySignature(envelope, trustedOperators, now);
  demand(envelope.challenge.jobId === id, 'approval binds a different job');
  const fresh = await inspectedSnapshot({ root, stateDir, id });
  demand(fresh.sourceRevision === envelope.challenge.sourceRevision &&
    fresh.checkedSourceBytes === envelope.challenge.checkedSourceBytes &&
    fresh.evidenceDigest === envelope.challenge.evidenceDigest,
  'approved job, revision, or evidence has changed');
  return { schemaVersion: 1, tool: 'AXIOMA_FORJA_OPERATOR_APPROVAL',
    status: 'APPROVED_FOR_MANUAL_REVIEW_ONLY', jobId: id, sourceRevision: fresh.sourceRevision,
    evidenceDigest: fresh.evidenceDigest, operatorId: envelope.operatorId,
    expiresAt: envelope.challenge.expiresAt,
    limitations: 'Local SHA-bound Ed25519 approval; no deployment, one-time redemption, host attestation, or external trust anchor.' };
}
async function readJson(path) { return JSON.parse((await boundedFile(path)).toString('utf8')); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, root, stateDir, id, envelopeFile, trustFile, ...extra] = process.argv.slice(2);
    demand(!extra.length && ['challenge', 'verify'].includes(command) && root && stateDir && id &&
      (command === 'challenge' ? !envelopeFile && !trustFile : isAbsolute(envelopeFile) && isAbsolute(trustFile)),
    'usage: node forja/operator-approval.mjs challenge|verify /abs/repo /abs/state job-id [signed.json /abs/trusted.json]');
    const result = command === 'challenge' ? await challengeForJob({ root, stateDir, id }) :
      await verifyApproval({ root, stateDir, id, envelope: await readJson(envelopeFile),
        trustedOperators: (await readJson(trustFile)).operators });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 300));
    process.exitCode = 1;
  }
}
