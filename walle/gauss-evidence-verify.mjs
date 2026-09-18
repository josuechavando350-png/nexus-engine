#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GAUSS_ENGINE_ID, sha256Canonical } from "../gauss/core/common.mjs";
import { executeGaussProblem } from "../gauss/core/problem.mjs";
import { contributeNexusQuantum } from "../gauss/core/quantum-contributor.mjs";
import { GAUSS_IMPLEMENTED_LAYERS } from "../gauss/core/registry.mjs";

const MAX_REPORT_BYTES = 16 * 1024 * 1024;

export async function verifyGaussFoundationEvidence({ problem, report }) {
  const expectedCount = problem?.tasks?.length;
  assert([200, 1000].includes(expectedCount), "GAUSS fixture must be historical 200 or full 1000");
  const expectedLayerIds = GAUSS_IMPLEMENTED_LAYERS.slice(0, expectedCount).map((layer) => layer.id).sort();
  const fixtureLayerIds = problem.tasks.map((task) => task.layerId).sort();
  assert.deepStrictEqual(fixtureLayerIds, expectedLayerIds, "GAUSS fixture must execute every required operator exactly once");

  assert.equal(report?.engineId, GAUSS_ENGINE_ID, "GAUSS engine identity mismatch");
  assert.equal(report?.status, "PASS", "GAUSS report must PASS");
  assert.equal(report?.registry?.targetLayerCount, 1000, "GAUSS target mismatch");
  assert.equal(report?.registry?.implementedLayerCount, GAUSS_IMPLEMENTED_LAYERS.length, "GAUSS implemented count mismatch");
  assert.equal(report?.executedLayerCount, expectedCount, "GAUSS executed count mismatch");
  assert.equal(report?.failedLayerCount, 0, "GAUSS failed count mismatch");
  assert.equal(report?.quantumContribution?.status, "EXECUTED", "Quantum contributor did not execute");
  assert.equal(report?.quantumContribution?.simulation?.verdict, "PASS", "Quantum simulation did not PASS");
  assert.equal(report?.quantumContribution?.simulation?.hardwareExecution, false, "physical QPU claim forbidden");
  assert.equal(report?.quantumContribution?.simulation?.quantumAdvantageClaimAllowed, false, "quantum advantage claim forbidden");

  const { reportSha256, ...unsigned } = report;
  assert.equal(reportSha256, sha256Canonical(unsigned), "GAUSS report SHA-256 mismatch");
  assert.equal(report.problemSha256, sha256Canonical(problem), "GAUSS problem SHA-256 mismatch");
  assert.equal(report.taskResults?.length, expectedCount, "task coverage mismatch");
  for (let i = 0; i < problem.tasks.length; i += 1) {
    const task = problem.tasks[i];
    const result = report.taskResults[i];
    assert.equal(result?.taskId, task.taskId, "task ID mismatch");
    assert.equal(result?.layerId, task.layerId, "task layer mismatch");
    assert.equal(result?.status, "EXECUTED", "task was not executed");
    assert.equal(result?.inputSha256, sha256Canonical(task.input), "task input SHA-256 mismatch");
    assert.equal(result?.outputSha256, sha256Canonical(result.output), "task output SHA-256 mismatch");
  }
  assert.equal(report.quantumContribution.problemSha256, report.problemSha256, "Quantum problem binding mismatch");
  const source = report.taskResults.find((item) => item.taskId === report.quantumContribution.sourceTaskId);
  assert(source, "Quantum source task missing");
  assert.equal(report.quantumContribution.sourceTaskOutputSha256, source.outputSha256, "Quantum source task output mismatch");

  // Re-execute independently of the supplied report. A tampered output with
  // recomputed hashes is not enough to pass this fixture-bound proof.
  const replay = await executeGaussProblem(problem, { quantumContributor: contributeNexusQuantum });
  assert.equal(report.reportSha256, replay.reportSha256, "GAUSS/Quantum replay differs from claimed evidence");
  assert.deepStrictEqual(report, replay, "GAUSS/Quantum replay differs from claimed evidence");
  return Object.freeze({ reportSha256, executedLayerCount: report.executedLayerCount, quantumExecuted: true });
}

async function readBoundedJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_REPORT_BYTES) {
    throw new Error("GAUSS evidence must be a bounded regular non-symlink file");
  }
  return readFile(path);
}

export async function verifyGaussEvidenceFile(path, problemPath = new URL("../gauss/fixtures/selftest-problem.json", import.meta.url)) {
  const [reportBytes, problemBytes] = await Promise.all([readBoundedJson(path), readBoundedJson(problemPath)]);
  const report = JSON.parse(reportBytes.toString("utf8"));
  const problem = JSON.parse(problemBytes.toString("utf8"));
  await verifyGaussFoundationEvidence({ problem, report });
  return Object.freeze({ artifactSha256: `sha256:${createHash("sha256").update(reportBytes).digest("hex")}`, executedLayerCount: report.executedLayerCount });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 3 && process.argv.length !== 4) throw new Error("Usage: node walle/gauss-evidence-verify.mjs <report.json> [problem.json]");
  const verified = await verifyGaussEvidenceFile(process.argv[2], process.argv[3] ?? new URL("../gauss/fixtures/selftest-problem.json", import.meta.url));
  console.log(`WALLE_GAUSS_REPORT_SHA256=${verified.artifactSha256}`);
  console.log(`WALLE_GAUSS_IMPLEMENTED_LAYERS=${verified.executedLayerCount}`);
}
