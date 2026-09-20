import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { evaluateEvidence, evaluateFiles } from '../evidence-gate.mjs';

const SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);
const gate = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'forja/evidence-gate.mjs');

// Synthetic inputs exercise failure behavior; they are not real Nexus evidence.
function fixture() {
  return {
    revision: SHA,
    inventory: { schemaVersion: 1, tool: 'AXIOMA_FORJA_GIT_TRACKED_INVENTORY', sourceRevision: SHA,
      status: 'RECORDED', counts: { trackedSourceFiles: 14, registeredSourceFiles: 5, notAuditedSourceFiles: 9 } },
    audit: { schemaVersion: 1, tool: 'AXIOMA_FORJA_EXPLICIT_SUBGRAPH_AUDIT', sourceRevision: SHA,
      status: 'PASS', checked: { registeredNodes: 5, availableNodes: 5, declaredLinks: 4, evidencedLinks: 4, reachableNodes: 5 },
      findings: [], nodes: Array.from({ length: 5 }, (_, i) => ({ path: `src/${i}.mjs`, sha256: HASH })) },
    contract: { schemaVersion: 1, tool: 'AXIOMA_FORJA_EXECUTED_GAUSS_QUANTUM_CONTRACT', sourceRevision: SHA,
      status: 'PASS', checked: { gaussTasks: 1, quantumSimulations: 1, independentIsingStates: 8 },
      problemSha256: HASH, gaussReportSha256: HASH, quantumReceiptSha256: HASH },
  };
}
function rejects(change, code) {
  const input = fixture();
  change(input);
  const result = evaluateEvidence(input);
  assert.equal(result.status, 'INCONSISTENT');
  assert.ok(result.findings.some((entry) => entry.code === code), JSON.stringify(result.findings));
}

test('internally consistent synthetic inputs never imply certification', () => {
  const result = evaluateEvidence(fixture());
  assert.equal(result.status, 'CONSISTENT');
  assert.match(result.limitations.join(' '), /not authenticated/);
  assert.match(result.limitations.join(' '), /NOT_AUDITED/);
});
test('rejects missing report', () => rejects((data) => { delete data.audit; }, 'INVALID_REPORT'));
test('rejects false tool identity', () => rejects((data) => { data.contract.tool = 'fake'; }, 'INVALID_REPORT'));
test('rejects mixed commits', () => rejects((data) => { data.audit.sourceRevision = 'c'.repeat(40); }, 'REVISION_MISMATCH'));
test('rejects dirty inventory', () => rejects((data) => { data.inventory.status = 'DIRTY_WORKTREE'; }, 'REPORT_NOT_PASSING'));
test('rejects skipped execution', () => rejects((data) => { data.contract.status = 'SKIPPED'; }, 'REPORT_NOT_PASSING'));
test('rejects invented inventory coverage', () => rejects((data) => { data.inventory.counts.notAuditedSourceFiles = 0; }, 'INVALID_INVENTORY_PARTITION'));
test('rejects unevidenced link', () => rejects((data) => { data.audit.checked.evidencedLinks = 3; }, 'INVALID_AUDIT_COVERAGE'));
test('rejects hidden findings under PASS', () => rejects((data) => { data.audit.findings.push({ code: 'BROKEN' }); }, 'INVALID_AUDIT_COVERAGE'));
test('rejects missing node hash', () => rejects((data) => { data.audit.nodes[0].sha256 = null; }, 'INVALID_AUDIT_COVERAGE'));
test('rejects absent Quantum receipt', () => rejects((data) => { data.contract.checked.quantumSimulations = 0; }, 'INVALID_EXECUTION_PROOF'));
test('rejects malformed revision', () => assert.throws(() => evaluateEvidence({ ...fixture(), revision: 'HEAD' }), /full lowercase/));

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function checkout(t) {
  const root = await mkdtemp(join(tmpdir(), 'forja-gate-repo-'));
  const output = await mkdtemp(join(tmpdir(), 'forja-gate-reports-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }); });
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'forja@example.invalid');
  git(root, 'config', 'user.name', 'FORJA test');
  await writeFile(join(root, 'tracked.txt'), 'tracked\n');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-qm', 'test');
  const revision = git(root, 'rev-parse', 'HEAD');
  const reports = fixture();
  for (const key of ['inventory', 'audit', 'contract']) {
    reports[key].sourceRevision = revision;
    await writeFile(join(output, `${key}.json`), JSON.stringify(reports[key]));
  }
  return { root, output, paths: {
    inventoryPath: join(output, 'inventory.json'), auditPath: join(output, 'audit.json'), contractPath: join(output, 'contract.json'),
  } };
}

test('file gate binds three reports to a real clean Git HEAD', async (t) => {
  const sample = await checkout(t);
  const report = await evaluateFiles({ root: sample.root, ...sample.paths });
  assert.equal(report.status, 'CONSISTENT');
  assert.equal(report.sourceRevision, git(sample.root, 'rev-parse', 'HEAD'));
});
test('CLI refuses missing arguments instead of treating them as a passing gate', () => {
  const result = spawnSync(process.execPath, [gate], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});
test('refuses dirty Git checkout', async (t) => {
  const sample = await checkout(t);
  await writeFile(join(sample.root, 'untracked.txt'), 'untracked');
  await assert.rejects(evaluateFiles({ root: sample.root, ...sample.paths }), /not clean/);
});
test('refuses symlinked report', async (t) => {
  const sample = await checkout(t);
  const alias = join(sample.output, 'alias.json');
  await symlink(sample.paths.auditPath, alias);
  await assert.rejects(evaluateFiles({ root: sample.root, ...sample.paths, auditPath: alias }), /bounded regular file/);
});
test('refuses workflow SHA mismatch', async (t) => {
  const sample = await checkout(t);
  const prior = process.env.FORJA_SOURCE_SHA;
  process.env.FORJA_SOURCE_SHA = SHA;
  try {
    await assert.rejects(evaluateFiles({ root: sample.root, ...sample.paths }), /does not match workflow revision/);
  } finally {
    if (prior === undefined) delete process.env.FORJA_SOURCE_SHA;
    else process.env.FORJA_SOURCE_SHA = prior;
  }
});
