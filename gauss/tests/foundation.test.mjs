import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { empiricalWasserstein2, graphLaplacian, paretoFrontier } from "../core/layers/math.mjs";
import { exactIsingGroundState, takensEmbedding } from "../core/layers/physics.mjs";
import { bootstrapMeanInterval, brierScore, wilsonInterval } from "../core/layers/statistics.mjs";
import { expectedUtility, minimaxRegret } from "../core/layers/decision.mjs";
import { differenceInDifferences, inversePropensityWeightedATE } from "../core/layers/causal.mjs";
import { eulerMaruyama, finiteHorizonScalarLQR } from "../core/layers/control.mjs";
import { mutualInformation, renyiDivergence, shannonEntropy } from "../core/layers/information.mjs";
import { exactBinaryKnapsack, verifyRequestEventuallyCertification } from "../core/layers/computing.mjs";
import { executeGaussProblem, validateGaussProblem } from "../core/problem.mjs";
import { GAUSS_IMPLEMENTED_LAYERS, gaussRegistrySummary } from "../core/registry.mjs";
import { contributeNexusQuantum } from "../core/quantum-contributor.mjs";
import { executeGaussIsingQaoaSimulation } from "../../seo-avengers-2500/quantum-runtime/gauss-ising-qaoa-simulator.mjs";

const fixture = JSON.parse(await readFile(new URL("../fixtures/selftest-problem.json", import.meta.url), "utf8"));

test("registry exposes exactly 21 executable foundation layers toward an 800-layer target", () => {
  const summary = gaussRegistrySummary();
  assert.equal(summary.targetLayerCount, 800);
  assert.equal(summary.implementedLayerCount, 21);
  assert.equal(GAUSS_IMPLEMENTED_LAYERS.length, 21);
  assert.equal(new Set(GAUSS_IMPLEMENTED_LAYERS.map((row) => row.id)).size, 21);
  for (const domain of summary.domains) assert.equal(domain.targetLayers, 100);
});

test("mathematics operators produce exact deterministic results", () => {
  assert.equal(empiricalWasserstein2({ left: [0, 1, 2], right: [1, 2, 3] }).distance, 1);
  assert.deepEqual(paretoFrontier({
    points: [{ id: "a", values: [10, 5] }, { id: "b", values: [9, 6] }, { id: "c", values: [12, 8] }],
    objectives: ["MAX", "MIN"],
  }).frontierIds, ["a", "c"]);
  assert.deepEqual(graphLaplacian({ adjacency: [[0, 2], [2, 0]] }).laplacian, [[2, -2], [-2, 2]]);
});

test("physics operators implement Takens and exact Ising search with the Quantum spin convention", () => {
  assert.deepEqual(takensEmbedding({ series: [0, 1, 2, 3, 4], dimension: 3, delay: 1 }).embedding, [[0, 1, 2], [1, 2, 3], [2, 3, 4]]);
  const ground = exactIsingGroundState({ fields: [0, 0], couplings: [{ i: 0, j: 1, value: -1 }] });
  assert.equal(ground.energy, -1);
  assert.equal(ground.degeneracy, 2);
  assert.equal(ground.evaluatedStates, 4);
  const biasedGround = exactIsingGroundState({ fields: [1], couplings: [] });
  assert.equal(biasedGround.energy, -1);
  assert.deepEqual(biasedGround.spins, [-1]);
});

test("statistics operators preserve calibration semantics", () => {
  const interval = wilsonInterval({ successes: 95, trials: 100, confidence: 0.95 });
  assert(interval.lower > 0.88 && interval.lower < 0.91);
  assert(interval.upper > 0.97 && interval.upper < 0.99);
  assert.equal(brierScore({ probabilities: [1, 0], outcomes: [1, 0] }).score, 0);
  const left = bootstrapMeanInterval({ samples: [1, 2, 3, 4], resamples: 500, seed: 99 });
  const right = bootstrapMeanInterval({ samples: [1, 2, 3, 4], resamples: 500, seed: 99 });
  assert.deepEqual(left, right);
});

test("decision and causal operators execute real formulas", () => {
  assert.equal(expectedUtility({ outcomes: [{ probability: 0.5, utility: 10 }, { probability: 0.5, utility: -2 }] }).expectedUtility, 4);
  assert.equal(minimaxRegret({ actions: ["a", "b"], payoffMatrix: [[10, 0], [6, 6]] }).selectedAction, "b");
  assert.equal(differenceInDifferences({ treatedPre: [10], treatedPost: [20], controlPre: [8], controlPost: [10] }).estimate, 8);
  const ate = inversePropensityWeightedATE({ rows: [
    { treatment: 1, outcome: 10, propensity: 0.5 },
    { treatment: 1, outcome: 8, propensity: 0.5 },
    { treatment: 0, outcome: 4, propensity: 0.5 },
    { treatment: 0, outcome: 6, propensity: 0.5 },
  ] });
  assert.equal(ate.estimate, 4);
});

test("control and information operators are deterministic and numerically stable", () => {
  const lqr = finiteHorizonScalarLQR({ a: 1, b: 1, q: 1, r: 1, terminalQ: 1, horizon: 4, initialState: 2 });
  assert.equal(lqr.controls.length, 4);
  assert(lqr.totalCost > 0);
  assert.deepEqual(
    eulerMaruyama({ x0: 1, mu: 0.1, sigma: 0.2, dt: 0.01, steps: 10, seed: 7 }),
    eulerMaruyama({ x0: 1, mu: 0.1, sigma: 0.2, dt: 0.01, steps: 10, seed: 7 }),
  );
  assert.equal(shannonEntropy({ probabilities: [0.5, 0.5], base: 2 }).entropy, 1);
  assert(mutualInformation({ joint: [[0.5, 0], [0, 0.5]], base: 2 }).mutualInformation > 0.999999);
  const finiteRenyi = renyiDivergence({ p: [0.5, 0.5], q: [0.25, 0.75], alpha: 2 });
  assert.equal(finiteRenyi.divergenceKind, "FINITE");
  assert(finiteRenyi.divergence > 0);
  assert.deepEqual(
    renyiDivergence({ p: [1, 0], q: [0, 1], alpha: 2 }),
    { divergenceKind: "POSITIVE_INFINITY", divergence: null, alpha: 2 },
  );
  const subunitRenyi = renyiDivergence({ p: [0.5, 0.5], q: [1, 0], alpha: 0.5 });
  assert.equal(subunitRenyi.divergenceKind, "FINITE");
  assert(Math.abs(subunitRenyi.divergence - Math.log(2)) < 1e-12);
  assert.deepEqual(
    renyiDivergence({ p: [1, 0], q: [0, 1], alpha: 0.5 }),
    { divergenceKind: "POSITIVE_INFINITY", divergence: null, alpha: 0.5 },
  );
  const klLimit = renyiDivergence({ p: [0.5, 0.5], q: [0.25, 0.75], alpha: 1 });
  assert.equal(klLimit.divergenceKind, "FINITE");
  assert(Math.abs(klLimit.divergence - (0.5 * Math.log(2) + 0.5 * Math.log(2 / 3))) < 1e-12);
  const highOrder = renyiDivergence({ p: [0.9, 0.1], q: [0.1, 0.9], alpha: 1000 });
  assert.equal(highOrder.divergenceKind, "FINITE");
  assert(Number.isFinite(highOrder.divergence));
});

test("computer-science operators solve exact bounded optimization and finite-trace temporal property", () => {
  const solution = exactBinaryKnapsack({ capacity: 5, items: [
    { id: "a", weight: 2, value: 3 },
    { id: "b", weight: 3, value: 4 },
    { id: "c", weight: 4, value: 5 },
  ] });
  assert.deepEqual(solution.selectedIds, ["a", "b"]);
  assert.equal(solution.totalValue, 7);
  assert.equal(verifyRequestEventuallyCertification({ trace: ["REQUEST", "WORK", "CERTIFICATION"] }).satisfied, true);
  assert.equal(verifyRequestEventuallyCertification({ trace: ["REQUEST", "WORK"] }).satisfied, false);
});

test("Quantum bridge executes an internal statevector QAOA simulation with the canonical spin convention and no hardware claim", () => {
  const receipt = executeGaussIsingQaoaSimulation({
    problem: { problemId: "qaoa-test", fields: [0, 0], couplings: [{ i: 0, j: 1, value: -1 }], offset: 0 },
    parameterSets: [{ parameterSetId: "p1", gammaMicroradians: [785398], betaMicroradians: [392699] }],
  });
  assert.equal(receipt.verdict, "PASS");
  assert.equal(receipt.hardwareExecution, false);
  assert.equal(receipt.quantumAdvantageClaimAllowed, false);
  assert(Math.abs(receipt.exactGroundStateEnergy + 1) < 1e-12);
  assert(receipt.candidates[0].normError < 1e-9);
  const biasedReceipt = executeGaussIsingQaoaSimulation({
    problem: { problemId: "qaoa-spin-convention", fields: [1], couplings: [], offset: 0 },
    parameterSets: [{ parameterSetId: "p1", gammaMicroradians: [785398], betaMicroradians: [392699] }],
  });
  assert.equal(biasedReceipt.candidates[0].groundStateMask, 1);
  assert.equal(biasedReceipt.exactGroundStateEnergy, -1);
});

test("end-to-end NEXUS -> GAUSS -> Quantum run executes all 21 implemented layers", async () => {
  const first = await executeGaussProblem(fixture, { quantumContributor: contributeNexusQuantum });
  const second = await executeGaussProblem(fixture, { quantumContributor: contributeNexusQuantum });
  assert.equal(first.status, "PASS");
  assert.equal(first.executedLayerCount, 21);
  assert.equal(first.failedLayerCount, 0);
  assert.equal(first.quantumContribution.status, "EXECUTED");
  assert.equal(first.quantumContribution.simulation.hardwareExecution, false);
  assert.equal(first.reportSha256, second.reportSha256);
});

test("GAUSS fails closed on an unimplemented layer instead of inventing an implementation", () => {
  assert.throws(() => validateGaussProblem({
    schemaVersion: 1,
    problemId: "no-shells",
    objective: "Do not allow fake layers",
    tasks: [{ taskId: "fake", layerId: "GAUSS.MATH.NOT_REAL.999", input: {} }],
  }), /unimplemented GAUSS layer/u);
});
