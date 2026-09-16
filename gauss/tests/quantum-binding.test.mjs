import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { executeGaussProblem } from "../core/problem.mjs";
import { contributeNexusQuantum } from "../core/quantum-contributor.mjs";
import { sha256Canonical } from "../core/common.mjs";

const fixture = JSON.parse(await readFile(new URL("../fixtures/selftest-problem.json", import.meta.url), "utf8"));

const forgedReceipt = (mutateSimulation) => async (context) => {
  const receipt = structuredClone(await contributeNexusQuantum(context));
  mutateSimulation(receipt.simulation);
  const { receiptSha256: ignored, ...unsigned } = receipt.simulation;
  void ignored;
  receipt.simulation.receiptSha256 = sha256Canonical(unsigned);
  return receipt;
};

test("authentic Quantum receipt matches the Ising Hamiltonian and independent ground energy", async () => {
  const report = await executeGaussProblem(fixture, { quantumContributor: contributeNexusQuantum });
  assert.equal(report.status, "PASS");
  const classical = report.taskResults.find((result) => result.taskId === "physics-ising-ground");
  assert(Math.abs(classical.output.energy - report.quantumContribution.simulation.exactGroundStateEnergy) < 1e-10);
});

test("forged Quantum problem hash is blocked even with a recomputed receipt hash", async () => {
  const report = await executeGaussProblem(fixture, {
    quantumContributor: forgedReceipt((simulation) => { simulation.problemSha256 = `sha256:${"0".repeat(64)}`; }),
  });
  assert.equal(report.status, "BLOCKED");
  assert.match(report.errors.join(" "), /not bound to the submitted Ising Hamiltonian/u);
});

test("forged Quantum ground energy is blocked even with a recomputed receipt hash", async () => {
  const report = await executeGaussProblem(fixture, {
    quantumContributor: forgedReceipt((simulation) => { simulation.exactGroundStateEnergy += 3; }),
  });
  assert.equal(report.status, "BLOCKED");
  assert.match(report.errors.join(" "), /exact ground energy disagrees/u);
});
