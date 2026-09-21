#!/usr/bin/env node
// Local content-addressed evidence storage. Integrity is NOT authentication.
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateVerifiedFiles } from './evidence-gate.mjs';
import { runWalleExecutedProbe } from './walle-executed-probe.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[a-f0-9]{40}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const digest = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`;

function requireCondition(value, message) {
  if (!value) throw new Error(`FORJA_LEDGER_ERROR: ${message}`);
}

function assertBundle(consistency, walle) {
  requireCondition(consistency?.schemaVersion === 1 && consistency?.tool === 'AXIOMA_FORJA_CROSS_REPORT_CONSISTENCY' &&
    consistency.status === 'CONSISTENT' && Array.isArray(consistency.findings) && consistency.findings.length === 0 &&
    Number.isSafeInteger(consistency.checkedSourceBytes) && consistency.checkedSourceBytes > 0 &&
    SHA.test(consistency.sourceRevision), 'consistency evidence is not verified');
  requireCondition(walle?.schemaVersion === 1 && walle?.tool === 'AXIOMA_FORJA_EXECUTED_WALLE_GAUSS_AXIOMA_CHAIN' &&
    walle.status === 'PASS' && walle.sourceRevision === consistency.sourceRevision && SHA.test(walle.sourceTree) &&
    walle.implementedLayers === 1000 && walle.quantumSimulation === 'CLASSICAL_ONLY' &&
    HASH.test(walle.reportSha256) && HASH.test(walle.axiomaSha256), 'WALLE evidence does not match verified source');
}

function assertOutsideProject(project, candidate, message) {
  const location = relative(project, candidate);
  requireCondition(location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location), message);
}

async function safeDirectory(storeRoot) {
  requireCondition(typeof storeRoot === 'string' && isAbsolute(storeRoot), 'store path must be absolute');
  const path = resolve(storeRoot);
  const project = await realpath(ROOT);
  assertOutsideProject(project, path, 'store must be outside source tree');
  // Resolve the closest existing ancestor *before* mkdir. If an external-looking
  // parent symlink enters the source tree, reject it without creating files there.
  let existing = path;
  for (;;) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      requireCondition(parent !== existing, 'store ancestor could not be resolved');
      existing = parent;
    }
  }
  const prospective = resolve(await realpath(existing), relative(existing, path));
  assertOutsideProject(project, prospective, 'resolved store must be outside source tree');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  requireCondition(stat.isDirectory() && !stat.isSymbolicLink(), 'store must be a real directory');
  // This postcondition also catches a changed symlink target during mkdir; it
  // does not claim protection against hostile concurrent filesystem mutation.
  const actualPath = await realpath(path);
  assertOutsideProject(project, actualPath, 'resolved store must be outside source tree');
  return path;
}

function recordFor(consistency, walle) {
  assertBundle(consistency, walle);
  const payload = { schemaVersion: 1, sourceRevision: consistency.sourceRevision, consistency, walle };
  const raw = JSON.stringify(payload);
  requireCondition(Buffer.byteLength(raw) <= MAX_RECORD_BYTES, 'evidence exceeds byte limit');
  const id = digest(raw);
  return { schemaVersion: 1, tool: 'AXIOMA_FORJA_LOCAL_EVIDENCE_LEDGER', id, payload };
}

export async function readLedgerRecord({ storeRoot, id }) {
  requireCondition(typeof id === 'string' && HASH.test(id), 'invalid record identifier');
  const root = await safeDirectory(storeRoot);
  const path = join(root, `${id.slice(7)}.json`);
  const stat = await lstat(path);
  requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.size > 2 && stat.size <= MAX_RECORD_BYTES, 'record is not a bounded regular file');
  const bytes = await readFile(path);
  requireCondition(bytes.length <= MAX_RECORD_BYTES, 'record exceeded byte limit');
  const record = JSON.parse(bytes.toString('utf8'));
  requireCondition(record?.schemaVersion === 1 && record?.tool === 'AXIOMA_FORJA_LOCAL_EVIDENCE_LEDGER' &&
    record.id === id && record.payload && typeof record.payload === 'object' &&
    Object.keys(record).length === 4 && digest(JSON.stringify(record.payload)) === id, 'record digest mismatch');
  assertBundle(record.payload.consistency, record.payload.walle);
  requireCondition(record.payload.sourceRevision === record.payload.consistency.sourceRevision, 'record source mismatch');
  return record;
}

export async function persistLedgerRecord({ storeRoot, consistency, walle }) {
  const record = recordFor(consistency, walle);
  const root = await safeDirectory(storeRoot);
  const finalPath = join(root, `${record.id.slice(7)}.json`);
  const tempPath = join(root, `.pending-${randomUUID()}`);
  const content = `${JSON.stringify(record)}\n`;
  requireCondition(Buffer.byteLength(content) <= MAX_RECORD_BYTES, 'record exceeds byte limit');
  let handle;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      // Hard-link publication is atomic and refuses to replace an existing digest.
      await link(tempPath, finalPath);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const stored = await readLedgerRecord({ storeRoot: root, id: record.id });
    requireCondition(JSON.stringify(stored) === JSON.stringify(record), 'existing record differs');
    return { id: record.id, sourceRevision: record.payload.sourceRevision, status: 'RECORDED', storeRoot: root };
  } finally {
    if (handle) await handle.close();
    await unlink(tempPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

export async function captureVerifiedLedger({ storeRoot, inventoryPath, auditPath, contractPath }) {
  const consistency = await evaluateVerifiedFiles({ root: ROOT, inventoryPath, auditPath, contractPath });
  requireCondition(consistency.status === 'CONSISTENT', 'live source evidence failed verification');
  const walle = await runWalleExecutedProbe();
  requireCondition(walle.sourceRevision === consistency.sourceRevision, 'source revision changed between probes');
  return persistLedgerRecord({ storeRoot, consistency, walle });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === 'capture' && args.length === 5) {
      const result = await captureVerifiedLedger({ inventoryPath: args[1], auditPath: args[2], contractPath: args[3], storeRoot: args[4] });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (args[0] === 'verify' && args.length === 3) {
      const result = await readLedgerRecord({ storeRoot: args[1], id: args[2] });
      process.stdout.write(`${JSON.stringify({ id: result.id, sourceRevision: result.payload.sourceRevision, status: 'INTEGRITY_MATCH' })}\n`);
    } else throw new Error('Usage: evidence-ledger.mjs capture <abs-inventory> <abs-audit> <abs-contract> <abs-store> | verify <abs-store> <sha256:id>');
  } catch (error) {
    console.error(`FORJA_LEDGER_ERROR: ${String(error?.message ?? error).replace(/[\r\n]+/gu, ' ').slice(0, 1200)}`);
    process.exitCode = 1;
  }
}
