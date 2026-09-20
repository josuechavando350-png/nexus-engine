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

// These are synthetic inputs for negative tests, not claims about Nexus.
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

test('consistent synthetic reports are explicitly NOT authenticated certification', () => {
  const result = evaluateEvidence(fixture());
  assert.equal(result.status, 'CONSISTENT');
  assert.match(result.limitations.join(' '), /not authenticated/);
  assert.match(result.limitations.join(' '), /NOT_AUDITED/);
});
test('rejects missing report', () => rejects((data) => { delete data.audit; }, 'INVALID_REPORT'));
test('rejects wrong tool identity', () => rejects((data) => { data.contract.tool = 'fabricated'; }, 'INVALID_REPORT'));
test('rejects mixed source revisions', () => rejects((data) => { data.audit.sourceRevision = 'c'.repeat(40); }, 'REVISION_MISMATCH'));
test('rejects dirty inventory', () => rejects((data) => { data.inventory.status = 'DIRTY_WORKTREE'; }, 'REPORT_NOT_PASSING'));
test('rejects a skipped execution', () => rejects((data) => { data.contract.status = 'SKIPPED'; }, 'REPORT_NOT_PASSING'));
test('rejects invented complete coverage', () => rejects((data) => { data.inventory.counts.notAuditedSourceFiles = 0; }, 'INVALID_INVENTORY_PARTITION'));
test('rejects an audit that omitted an edge', () => rejects((data) => { data.audit.checked.evidencedLinks = 3; }, 'INVALID_AUDIT_COVERAGE'));
test('rejects hidden findings even with PASS status', () => rejects((data) => { data.audit.findings.push({ code: 'BROKEN' }); }, 'INVALID_AUDIT_COVERAGE'));
test('rejects a missing node digest', () => rejects((data) => { data.audit.nodes[0].sha256 = null; }, 'INVALID_AUDIT_COVERAGE'));
test('rejects missing Quantum execution receipt', () => rejects((data) => { data.contract.checked.quantumSimulations = 0; }, 'INVALID_EXECUTION_PROOF'));
test('rejects unsupported revision syntax', () => assert.throws(() => evaluateEvidence({ ...fixture(), revision: 'HEAD' }), /full lowercase/));

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function checkout(t) {
  const root = await mkdtemp(join(tmpdir(), 'forja-evidence-repo-'));
  const output = await mkdtemp(join(tmpdir(), 'forja-evidence-files-'));
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

test('CLI reads three external files and binds their evidence to Git HEAD', async (t) => {
  const sample = await checkout(t);
  const report = await evaluateFiles({ root: sample.root, ...sample.paths });
  assert.equal(report.status, 'CONSISTENT');
  const cli = spawnSync(process.execPath, [gate, ...Object.values(sample.paths)], { cwd: sample.root, encoding: 'utf8' });
  // CLI is deliberately bound to the checkout containing this tool, not an arbitrary --root.
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /REVISION_MISMATCH|FORJA_EVIDENCE_GATE_ERROR/);
});
test('refuses dirty checkouts', async (t) => {
  const sample = await checkout(t);
  await writeFile(join(sample.root, 'untracked.txt'), 'untracked');
  await assert.rejects(evaluateFiles({ root: sample.root, ...sample.paths }), /not clean/);
});
test('refuses symlinked evidence files', async (t) => {
  const sample = await checkout(t);
  const alias = join(sample.output, 'alias.json');
  await symlink(sample.paths.auditPath, alias);
  await assert.rejects(evaluateFiles({ root: sample.root, ...sample.paths, auditPath: alias }), /bounded regular file/);
});
test('refuses mismatched workflow commit', async (t) => {
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
