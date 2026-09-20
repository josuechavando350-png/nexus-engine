#!/usr/bin/env node
// Single-host one-time MANUAL REVIEW receipt. This is not a deploy authorization.
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyApproval } from './operator-approval.mjs';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const MAX_INPUT = 2 * 1024 * 1024;
function fail(reason) { throw new Error(`FORJA_REDEMPTION: ${reason}`); }
function requirePrivateDirectory(stat, label) {
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    fail(`${label} must be an owned private directory (0700 or stricter)`);
  }
}
async function privateState(stateDir) {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) fail('absolute state directory required');
  requirePrivateDirectory(await lstat(stateDir), 'state'); // reject final-component symlinks
  return realpath(stateDir);
}
async function privateReceipts(state) {
  const directory = join(state, 'approval-redemptions');
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  requirePrivateDirectory(await lstat(directory), 'redemption store');
  return directory;
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export async function redeemApproval({ root, stateDir, id, envelope, trustedOperators, now = Date.now() }) {
  // No receipt may be issued merely because a signature is valid: inspect ALL current evidence.
  const state = await privateState(stateDir);
  const accepted = await verifyApproval({ root, stateDir: state, id, envelope, trustedOperators, now });
  const nonce = envelope.challenge.nonce;
  if (!UUID.test(nonce)) fail('invalid nonce');
  const directory = await privateReceipts(state);
  const receipt = { schemaVersion: 1, status: 'CONSUMED_FOR_MANUAL_REVIEW_ONLY', nonce,
    jobId: accepted.jobId, sourceRevision: accepted.sourceRevision,
    evidenceDigest: accepted.evidenceDigest, operatorId: accepted.operatorId,
    signatureDigest: sha256(Buffer.from(envelope.signature, 'base64')),
    consumedAt: new Date(now).toISOString(), expiresAt: accepted.expiresAt };
  // O_EXCL is the cross-process decision point. A crash leaves a reserved nonce
  // which is NEVER deleted or retried silently; a new human challenge is needed.
  const path = join(directory, `${nonce}.json`);
  let file;
  try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('nonce already consumed or reserved'); throw error; }
  try {
    await file.writeFile(`${JSON.stringify(receipt)}\n`, 'utf8');
    await file.sync();
  } finally { await file.close(); }
  const directoryFd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directoryFd.sync(); } finally { await directoryFd.close(); }
  return receipt;
}
async function boundedJson(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('absolute input path required');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_INPUT) fail('unsafe or oversized input');
    const bytes = await fd.readFile();
    if (bytes.length !== stat.size) fail('input changed during read');
    return JSON.parse(bytes.toString('utf8'));
  } finally { await fd.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, stateDir, id, envelopeFile, trustFile, ...extra] = process.argv.slice(2);
    if (extra.length || !root || !stateDir || !id || !envelopeFile || !trustFile) {
      fail('usage: node forja/approval-redemption.mjs /abs/repo /abs/state job-id /abs/signed.json /abs/trusted.json');
    }
    const trusted = await boundedJson(trustFile);
    if (!trusted || !Object.hasOwn(trusted, 'operators')) fail('trusted operators missing');
    const result = await redeemApproval({ root, stateDir, id,
      envelope: await boundedJson(envelopeFile), trustedOperators: trusted.operators });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 300));
    process.exitCode = 1;
  }
}
