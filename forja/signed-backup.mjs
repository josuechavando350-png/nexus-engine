#!/usr/bin/env node
// Optional Ed25519 authenticity for an offline snapshot using an independently pinned public key.
// A valid signature does not prove freshness, prevent rollback or authorize replay of approvals.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySnapshot, restoreSnapshot } from './state-backup.mjs';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RECEIPT_KEYS = ['algorithm', 'manifestSha256', 'schemaVersion', 'signature', 'signerKeySha256', 'snapshotId', 'tool'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function demand(ok, reason) { if (!ok) throw new Error(`FORJA_SIGNED_BACKUP: ${reason}`); }
function outside(a, b) { const path = relative(a, b); return path === '..' || path.startsWith(`..${sep}`); }
async function privateDir(path) {
  demand(typeof path === 'string' && isAbsolute(path), 'absolute private directory required');
  const s = await lstat(path);
  demand(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o077) === 0 &&
    (typeof process.getuid !== 'function' || s.uid === process.getuid()), 'directory must be private and owned');
  return realpath(path);
}
async function keyFile(path, { secret = false } = {}) {
  demand(typeof path === 'string' && isAbsolute(path), 'absolute key file required');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await fd.stat();
    demand(s.isFile() && s.nlink === 1 && s.size > 0 && s.size <= 8192 &&
      (typeof process.getuid !== 'function' || s.uid === process.getuid()) &&
      (secret ? (s.mode & 0o077) === 0 : (s.mode & 0o022) === 0), 'unsafe key file');
    const data = await fd.readFile();
    demand(data.length === s.size, 'key file changed during read');
    return data;
  } finally { await fd.close(); }
}
async function receiptFile(path) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await fd.stat();
    demand(s.isFile() && s.nlink === 1 && s.size > 0 && s.size <= 4096 &&
      (s.mode & 0o077) === 0 &&
      (typeof process.getuid !== 'function' || s.uid === process.getuid()), 'unsafe receipt file');
    const bytes = await fd.readFile();
    demand(bytes.length === s.size, 'receipt changed during read');
    return JSON.parse(bytes.toString('utf8'));
  } finally { await fd.close(); }
}
function fingerprint(publicKey) { return sha256(publicKey.export({type:'spki',format:'der'})); }
function message(id, manifestSha256) {
  return Buffer.from(`AXIOMA_FORJA_SNAPSHOT_ATTESTATION_V1\n${id}\n${manifestSha256}\n`, 'ascii');
}
async function pathOutsideRoots(path, ...roots) {
  const parent = await realpath(dirname(resolve(path)));
  const actual = join(parent, basename(path));
  demand(roots.every((root) => outside(root, actual) && outside(actual, root)), 'key must be outside backup and receipts roots');
}
async function receiptRoots(backupRoot, receiptsRoot) {
  const backup = await privateDir(backupRoot), receipts = await privateDir(receiptsRoot);
  demand(outside(backup, receipts) && outside(receipts, backup), 'backup and receipts must be disjoint');
  return {backup, receipts};
}
function receiptShape(receipt, id) {
  demand(receipt && typeof receipt === 'object' && !Array.isArray(receipt) &&
    Object.keys(receipt).sort().join('|') === RECEIPT_KEYS.join('|') &&
    receipt.schemaVersion === 1 && receipt.tool === 'AXIOMA_FORJA_SIGNED_SNAPSHOT' &&
    receipt.algorithm === 'Ed25519' && receipt.snapshotId === id &&
    SHA256.test(receipt.manifestSha256) && SHA256.test(receipt.signerKeySha256) &&
    typeof receipt.signature === 'string', 'invalid signed receipt');
  const signature = Buffer.from(receipt.signature, 'base64');
  demand(signature.length === 64 && signature.toString('base64') === receipt.signature, 'invalid signature encoding');
  return signature;
}
export async function signSnapshot(backupRoot, id, privateKeyPath, receiptsRoot) {
  demand(typeof id === 'string' && UUID.test(id), 'invalid snapshot id');
  const {backup, receipts} = await receiptRoots(backupRoot, receiptsRoot);
  await pathOutsideRoots(privateKeyPath, backup, receipts);
  const verified = await verifySnapshot(backup, id);
  const key = createPrivateKey(await keyFile(privateKeyPath, {secret:true}));
  demand(key.asymmetricKeyType === 'ed25519', 'Ed25519 private key required');
  const publicKey = createPublicKey(key);
  const receipt = {schemaVersion:1, tool:'AXIOMA_FORJA_SIGNED_SNAPSHOT', algorithm:'Ed25519',
    snapshotId:id, manifestSha256:verified.manifestSha256,
    signerKeySha256:fingerprint(publicKey),
    signature:sign(null, message(id, verified.manifestSha256), key).toString('base64')};
  const fd = await open(join(receipts, `${id}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(`${JSON.stringify(receipt)}\n`); await fd.sync(); }
  finally { await fd.close(); }
  const dir = await open(receipts, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
  return receipt;
}
export async function verifySignedSnapshot(backupRoot, id, receiptsRoot, publicKeyPath, expectedKeySha256) {
  demand(typeof id === 'string' && UUID.test(id) && typeof expectedKeySha256 === 'string' &&
    SHA256.test(expectedKeySha256), 'snapshot id and independently pinned key fingerprint required');
  const {backup, receipts} = await receiptRoots(backupRoot, receiptsRoot);
  await pathOutsideRoots(publicKeyPath, backup, receipts);
  const publicKey = createPublicKey(await keyFile(publicKeyPath));
  demand(publicKey.asymmetricKeyType === 'ed25519' && fingerprint(publicKey) === expectedKeySha256,
    'untrusted public key');
  const receipt = await receiptFile(join(receipts, `${id}.json`));
  const signature = receiptShape(receipt, id);
  demand(receipt.signerKeySha256 === expectedKeySha256 &&
    verify(null, message(id, receipt.manifestSha256), publicKey, signature), 'signed receipt signature mismatch');
  const snapshot = await verifySnapshot(backup, id);
  demand(snapshot.manifestSha256 === receipt.manifestSha256, 'signed manifest does not match snapshot');
  return {...snapshot, signerKeySha256:expectedKeySha256, status:'SIGNED_SNAPSHOT_VERIFIED'};
}
export async function restoreSignedSnapshot(backupRoot, id, receiptsRoot, publicKeyPath, expectedKeySha256, targetDir) {
  const verified = await verifySignedSnapshot(backupRoot, id, receiptsRoot, publicKeyPath, expectedKeySha256);
  // The expected digest is checked again on the bytes read for restore; never trust an earlier verification alone.
  const restored = await restoreSnapshot(backupRoot, id, targetDir, verified.manifestSha256);
  return {...restored, manifestSha256:verified.manifestSha256, signerKeySha256:verified.signerKeySha256,
    status:'SIGNED_SNAPSHOT_RESTORED_QUARANTINED'};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    demand((command === 'sign' && args.length === 4) || (command === 'verify' && args.length === 5) ||
      (command === 'restore' && args.length === 6),
      'usage: sign backupRoot id privateKeyPath receiptsRoot | verify backupRoot id receiptsRoot publicKeyPath pinnedSHA256 | restore backupRoot id receiptsRoot publicKeyPath pinnedSHA256 absentTarget');
    const result = command === 'sign' ? await signSnapshot(...args) : command === 'verify' ?
      await verifySignedSnapshot(...args) : await restoreSignedSnapshot(...args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(String(error?.message ?? error).replace(/[\r\n]+/g,' ').slice(0,500));
    process.exitCode = 1;
  }
}
