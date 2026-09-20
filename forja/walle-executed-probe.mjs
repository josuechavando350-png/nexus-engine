#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from '../gauss/core/common.mjs';
import { verifyGaussEvidenceFile } from '../walle/gauss-evidence-verify.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const FIXTURE = join(ROOT, 'gauss/fixtures/gauss-1000-selftest.json');
const MAX_REPORT_BYTES = 16 * 1024 * 1024;

function check(condition, detail) {
  if (!condition) throw new Error(`FORJA_WALLE_CONTRACT_FAIL: ${detail}`);
}

function git(...args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
  check(!result.error && result.status === 0 && !result.signal, 'Git source identity unavailable');
  return result.stdout.trim();
}

// The existing WALLE verifier and adapter both print the same count. Require
// identical repeated values; conflicting repeated evidence is never accepted.
export function assertWalleReceipt(text, { sourceRevision, sourceTree, reportSha256, axiomaSha256 }) {
  check(SHA.test(sourceRevision) && SHA.test(sourceTree), 'invalid source identity');
  check(HASH.test(reportSha256) && HASH.test(axiomaSha256), 'invalid evidence digests');
  check(typeof text === 'string' && Buffer.byteLength(text) <= 4 * 1024 * 1024, 'unbounded output');
  const receipt = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('WALLE_')) continue;
    const matched = /^(WALLE_[A-Z0-9_]+)=(\S+)$/.exec(line);
    check(matched, 'invalid WALLE receipt line');
    if (receipt.has(matched[1])) {
      check(receipt.get(matched[1]) === matched[2], `conflicting WALLE receipt field ${matched[1]}`);
      continue;
    }
    receipt.set(matched[1], matched[2]);
  }
  const expected = new Map([
    ['WALLE_GAUSS_SOURCE_REVISION', sourceRevision],
    ['WALLE_GAUSS_SOURCE_TREE', sourceTree],
    ['WALLE_GAUSS_TARGET_LAYERS', '1000'],
    ['WALLE_GAUSS_IMPLEMENTED_LAYERS', '1000'],
    ['WALLE_GAUSS_QUANTUM_EXECUTED', 'true'],
    ['WALLE_GAUSS_PHYSICAL_QPU_EXECUTED', 'false'],
    ['WALLE_GAUSS_FOUNDATION_CLAIM', 'true'],
    ['WALLE_GAUSS_REPORT_SHA256', reportSha256],
    ['WALLE_AXIOMA_EVIDENCE_SHA256', axiomaSha256],
    ['WALLE_AXIOMA_SOURCE_REVISION', sourceRevision],
    ['WALLE_GAUSS_FULL_CATALOG_CERTIFIED', 'true'],
  ]);
  check(receipt.size === expected.size, 'missing or extra WALLE evidence fields');
  for (const [key, value] of expected) check(receipt.get(key) === value, `WALLE evidence mismatch: ${key}`);
  return Object.freeze({ sourceRevision, sourceTree, implementedLayers: 1000, reportSha256, axiomaSha256 });
}

async function readEvidence(path) {
  const stat = await lstat(path);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_REPORT_BYTES, 'invalid evidence file');
  return JSON.parse((await readFile(path, 'utf8')));
}

export async function runWalleExecutedProbe() {
  const revision = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  check(SHA.test(revision) && SHA.test(tree) && git('status', '--porcelain=v1', '--untracked-files=all') === '', 'checkout not pristine');
  check(!process.env.FORJA_SOURCE_SHA || process.env.FORJA_SOURCE_SHA === revision, 'wrong workflow source revision');
  const directory = await mkdtemp(join(tmpdir(), 'forja-walle-real-'));
  try {
    const result = spawnSync('bash', [join(ROOT, 'walle/adapters/gauss.sh')], {
      cwd: ROOT, env: { ...process.env, WALLE_GAUSS_EVIDENCE_ROOT: directory },
      encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    check(!result.error && !result.signal && result.status === 0, `real WALLE adapter failed: ${String(result.error?.message ?? result.stderr ?? result.signal ?? result.status).slice(-1200)}`);
    const reportPath = join(directory, 'gauss-foundation-report.json');
    const axiomaPath = join(directory, 'axioma-evidence.json');
    const verified = await verifyGaussEvidenceFile(reportPath, FIXTURE, axiomaPath);
    check(verified.certifiedFullCatalog && verified.executedLayerCount === 1000 && HASH.test(verified.axiomaEvidenceSha256), 'WALLE verifier did not validate full fixture');
    const [report, axioma] = await Promise.all([readEvidence(reportPath), readEvidence(axiomaPath)]);
    const { reportSha256, ...unsigned } = report;
    check(reportSha256 === sha256Canonical(unsigned), 'GAUSS report digest mismatch');
    check(axioma.evidenceSha256 === verified.axiomaEvidenceSha256 && axioma.gaussReportSha256 === reportSha256, 'AXIOMA binding mismatch');
    const receipt = assertWalleReceipt(result.stdout, {
      sourceRevision: revision, sourceTree: tree, reportSha256: verified.artifactSha256,
      axiomaSha256: verified.axiomaEvidenceSha256,
    });
    check(git('rev-parse', 'HEAD') === revision && git('rev-parse', 'HEAD^{tree}') === tree &&
      git('status', '--porcelain=v1', '--untracked-files=all') === '', 'source changed during probe');
    return {
      schemaVersion: 1, tool: 'AXIOMA_FORJA_EXECUTED_WALLE_GAUSS_AXIOMA_CHAIN',
      status: 'PASS', ...receipt, quantumSimulation: 'CLASSICAL_ONLY',
      limitations: ['The existing GAUSS and AXIOMA replay verifiers share their in-repository implementations.',
        'No physical QPU, independent oracle for all 1000 operators, production deployment or all-Nexus certification.'],
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    check(process.argv.length === 2, 'no arguments accepted');
    process.stdout.write(`${JSON.stringify(await runWalleExecutedProbe(), null, 2)}\n`);
  } catch (cause) {
    console.error(`FORJA_WALLE_ERROR: ${String(cause?.message ?? cause).replace(/[\r\n]+/g, ' ').slice(0, 2000)}`);
    process.exitCode = 1;
  }
}
