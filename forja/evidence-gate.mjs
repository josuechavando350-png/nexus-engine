#!/usr/bin/env node
// Consistency check for reports generated on one clean checkout. Not a signed attestation.
import { spawnSync } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const TOOLS = Object.freeze({
  inventory: 'AXIOMA_FORJA_GIT_TRACKED_INVENTORY',
  audit: 'AXIOMA_FORJA_EXPLICIT_SUBGRAPH_AUDIT',
  contract: 'AXIOMA_FORJA_EXECUTED_GAUSS_QUANTUM_CONTRACT',
});

export function evaluateEvidence({ revision, inventory, audit, contract }) {
  if (!SHA.test(revision)) throw new Error('Expected a full lowercase Git revision');
  const findings = [];
  const fail = (code, detail) => findings.push({ code, detail });
  for (const [name, report] of Object.entries({ inventory, audit, contract })) {
    if (!report || typeof report !== 'object' || Array.isArray(report) || report.schemaVersion !== 1 || report.tool !== TOOLS[name]) {
      fail('INVALID_REPORT', name);
      continue;
    }
    if (report.sourceRevision !== revision) fail('REVISION_MISMATCH', name);
    if (report.status !== (name === 'inventory' ? 'RECORDED' : 'PASS')) fail('REPORT_NOT_PASSING', name);
  }
  if (!findings.length) {
    const number = (value) => Number.isSafeInteger(value) && value >= 0;
    const counts = inventory.counts;
    const checked = audit.checked;
    const proof = contract.checked;
    if (!counts || !number(counts.trackedSourceFiles) || !number(counts.registeredSourceFiles) ||
        !number(counts.notAuditedSourceFiles) || counts.registeredSourceFiles < 1 ||
        counts.trackedSourceFiles !== counts.registeredSourceFiles + counts.notAuditedSourceFiles) {
      fail('INVALID_INVENTORY_PARTITION', 'tracked and registered source counts');
    }
    if (!checked || !number(checked.registeredNodes) || !number(checked.availableNodes) ||
        !number(checked.declaredLinks) || !number(checked.evidencedLinks) || !number(checked.reachableNodes) ||
        checked.registeredNodes < 1 || checked.registeredNodes !== counts?.registeredSourceFiles ||
        checked.availableNodes !== checked.registeredNodes || checked.reachableNodes !== checked.registeredNodes ||
        checked.evidencedLinks !== checked.declaredLinks || !Array.isArray(audit.findings) || audit.findings.length ||
        !Array.isArray(audit.nodes) || audit.nodes.length !== checked.registeredNodes ||
        audit.nodes.some((node) => !node || typeof node.path !== 'string' || !HASH.test(node.sha256))) {
      fail('INVALID_AUDIT_COVERAGE', 'only the explicit registered subset is checked');
    }
    if (!proof || proof.gaussTasks !== 1 || proof.quantumSimulations !== 1 ||
        proof.independentIsingStates !== 8 || !HASH.test(contract.problemSha256) ||
        !HASH.test(contract.gaussReportSha256) || !HASH.test(contract.quantumReceiptSha256)) {
      fail('INVALID_EXECUTION_PROOF', 'single bounded Ising fixture');
    }
  }
  return {
    schemaVersion: 1, tool: 'AXIOMA_FORJA_CROSS_REPORT_CONSISTENCY', sourceRevision: revision,
    status: findings.length ? 'INCONSISTENT' : 'CONSISTENT', findings,
    scope: 'one Git revision, registered source subset, single GAUSS-to-classical-Quantum probe',
    limitations: [
      'Input JSON is not authenticated and may be forged; consistency is not certification.',
      'Registered-node hashes are not recomputed from repository bytes by this gate.',
      'Unregistered source remains NOT_AUDITED. No production, deployment or self-repair approval.',
    ],
  };
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0 || result.signal) throw new Error('Git checkout identity unavailable');
  return result.stdout.trim();
}

async function readReport(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Report paths must be absolute');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 2 * 1024 * 1024) {
    throw new Error('Report must be a bounded regular file');
  }
  const bytes = await readFile(path);
  if (bytes.length > 2 * 1024 * 1024) throw new Error('Report exceeds byte limit');
  return JSON.parse(bytes.toString('utf8'));
}

export async function evaluateFiles({ root, inventoryPath, auditPath, contractPath }) {
  const directory = resolve(root);
  const gitRoot = git(directory, 'rev-parse', '--show-toplevel');
  if (await realpath(directory) !== await realpath(gitRoot)) throw new Error('Run at repository root');
  const revision = git(directory, 'rev-parse', 'HEAD');
  if (!SHA.test(revision) || (process.env.FORJA_SOURCE_SHA && process.env.FORJA_SOURCE_SHA !== revision)) {
    throw new Error('Git HEAD does not match workflow revision');
  }
  if (git(directory, 'status', '--porcelain=v1', '--untracked-files=all')) throw new Error('Working tree is not clean');
  const paths = [inventoryPath, auditPath, contractPath];
  if (new Set(paths).size !== 3) throw new Error('Reports must use distinct paths');
  const [inventory, audit, contract] = await Promise.all(paths.map(readReport));
  return evaluateEvidence({ revision, inventory, audit, contract });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3) throw new Error('Usage: node forja/evidence-gate.mjs /abs/inventory.json /abs/audit.json /abs/contract.json');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const result = await evaluateFiles({ root, inventoryPath: args[0], auditPath: args[1], contractPath: args[2] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== 'CONSISTENT') process.exitCode = 1;
  } catch (cause) {
    console.error(`FORJA_EVIDENCE_GATE_ERROR: ${String(cause?.message ?? cause).replace(/[\r\n]+/g, ' ').slice(0, 2048)}`);
    process.exitCode = 2;
  }
}
