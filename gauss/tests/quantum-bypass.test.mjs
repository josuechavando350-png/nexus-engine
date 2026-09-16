import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { executeGaussProblem } from "../core/problem.mjs";
import { contributeNexusQuantum } from "../core/quantum-contributor.mjs";

const fixture = JSON.parse(await readFile(new URL("../fixtures/selftest-problem.json", import.meta.url), "utf8"));

test("GAUSS refuses to execute without the Nexus Quantum contributor", async () => {
  await assert.rejects(executeGaussProblem(fixture), /Nexus Quantum contributor is required/u);
  await assert.rejects(executeGaussProblem(fixture, { quantumContributor: null }), /Nexus Quantum contributor is required/u);
});

test("missing or forged Quantum contributions block PASS even if GAUSS mathematical tasks executed", async () => {
  const missing = await executeGaussProblem(fixture, { quantumContributor: async () => null });
  assert.equal(missing.status, "BLOCKED");
  assert.equal(missing.executedLayerCount, 20);
  assert.match(missing.errors.join(" "), /problem-bound EXECUTED receipt/u);

  const forged = await executeGaussProblem(fixture, {
    quantumContributor: async ({ problemSha256 }) => ({
      engineId: "NEXUS_QUANTUM", problemSha256, status: "EXECUTED",
      simulation: { verdict: "PASS", hardwareExecution: true, quantumAdvantageClaimAllowed: false },
    }),
  });
  assert.equal(forged.status, "BLOCKED");
  assert.match(forged.errors.join(" "), /misrepresents hardware/u);
});

test("all Ising subproblems must be covered: two tasks cannot silently reuse one Quantum receipt", async () => {
  const duplicate = structuredClone(fixture);
  const ising = duplicate.tasks.find((task) => task.layerId === "GAUSS.PHYSICS.ISING_EXACT_GROUND.003");
  duplicate.tasks.push({ ...structuredClone(ising), taskId: "ising-second" });
  const report = await executeGaussProblem(duplicate, { quantumContributor: contributeNexusQuantum });
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.executedLayerCount, 21);
  assert.match(report.errors.join(" "), /multiple Ising subproblems/u);
});

test("non-Ising problems still consult Quantum and receive an explicit NOT_APPLICABLE receipt", async () => {
  const nonIsing = { ...structuredClone(fixture), tasks: [structuredClone(fixture.tasks[0])] };
  const report = await executeGaussProblem(nonIsing, { quantumContributor: contributeNexusQuantum });
  assert.equal(report.status, "PASS");
  assert.equal(report.executedLayerCount, 1);
  assert.equal(report.quantumContribution.status, "NOT_APPLICABLE");
  assert.deepEqual(report.quantumContribution.reasonCodes, ["NO_ISING_SUBPROBLEM"]);
});
