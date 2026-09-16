import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sha256Canonical } from "../core/common.mjs";
import { executeGaussProblem } from "../core/problem.mjs";
import { contributeNexusQuantum } from "../core/quantum-contributor.mjs";
import { verifyGaussFoundationEvidence } from "../../walle/gauss-evidence-verify.mjs";

const problem = JSON.parse(await readFile(new URL("../fixtures/selftest-problem.json", import.meta.url), "utf8"));
const genuineReport = JSON.parse(JSON.stringify(await executeGaussProblem(problem, { quantumContributor: contributeNexusQuantum })));

function tamper(edit) {
  const fake = structuredClone(genuineReport);
  edit(fake);
  const { reportSha256: ignored, ...unsigned } = fake;
  void ignored;
  fake.reportSha256 = sha256Canonical(unsigned);
  return fake;
}

test("WALLE accepts only replayable, hash-bound GAUSS and Quantum foundation evidence", async () => {
  const verified = await verifyGaussFoundationEvidence({ problem, report: genuineReport });
  assert.equal(verified.reportSha256, genuineReport.reportSha256);
  assert.equal(verified.executedLayerCount, problem.tasks.length);
});

test("WALLE rejects a fixture with a repeated layer even when total task count is unchanged", async () => {
  const incomplete = structuredClone(problem);
  incomplete.tasks[3] = { ...structuredClone(incomplete.tasks[0]), taskId: "duplicated-math-w2" };
  await assert.rejects(
    verifyGaussFoundationEvidence({ problem: incomplete, report: genuineReport }),
    /every registered layer exactly once/u,
  );
});

test("WALLE rejects an altered output even if its output and report hashes are recomputed", async () => {
  const fake = tamper((report) => {
    report.taskResults[0].output.distance += 0.25;
    report.taskResults[0].outputSha256 = sha256Canonical(report.taskResults[0].output);
  });
  await assert.rejects(verifyGaussFoundationEvidence({ problem, report: fake }), /replay differs/u);
});

test("WALLE rejects forged CVaR even if the output and report hashes are recomputed", async () => {
  const fake = tamper((report) => {
    const result = report.taskResults.find((task) => task.layerId === "GAUSS.DECISION.CVAR_DISCRETE.003");
    assert(result, "CVaR fixture task missing");
    result.output.conditionalValueAtRisk += 1;
    result.outputSha256 = sha256Canonical(result.output);
  });
  await assert.rejects(verifyGaussFoundationEvidence({ problem, report: fake }), /replay differs/u);
});

test("WALLE rejects forged EVaR even if the output and report hashes are recomputed", async () => {
  const fake = tamper((report) => {
    const result = report.taskResults.find((task) => task.layerId === "GAUSS.DECISION.EVAR_DISCRETE.004");
    assert(result, "EVaR fixture task missing");
    result.output.entropicValueAtRisk += 1;
    result.outputSha256 = sha256Canonical(result.output);
  });
  await assert.rejects(verifyGaussFoundationEvidence({ problem, report: fake }), /replay differs/u);
});

test("WALLE rejects a forged PASS or a missing Quantum contribution", async () => {
  const fake = tamper((report) => { report.quantumContribution.simulation.hardwareExecution = true; });
  await assert.rejects(verifyGaussFoundationEvidence({ problem, report: fake }), /physical QPU claim forbidden/u);
  const absent = tamper((report) => { report.quantumContribution = null; });
  await assert.rejects(verifyGaussFoundationEvidence({ problem, report: absent }), /Quantum contributor did not execute/u);
});

test("WALLE rejects a report hash that only looks like SHA-256", async () => {
  const fake = structuredClone(genuineReport);
  fake.reportSha256 = `sha256:${"0".repeat(64)}`;
  await assert.rejects(verifyGaussFoundationEvidence({ problem, report: fake }), /report SHA-256 mismatch/u);
});

test("WALLE rejects a Quantum simulation altered behind an otherwise valid GAUSS hash", async () => {
  const fake = tamper((report) => { report.quantumContribution.simulation.selectedExpectedEnergy += 1; });
  await assert.rejects(verifyGaussFoundationEvidence({ problem, report: fake }), /replay differs/u);
});
