import assert from "node:assert/strict";
import test from "node:test";

import { graphLaplacian } from "../core/layers/math.mjs";
import { exactIsingGroundState } from "../core/layers/physics.mjs";
import { executeGaussIsingQaoaSimulation } from "../../seo-avengers-2500/quantum-runtime/gauss-ising-qaoa-simulator.mjs";

test("an undirected graph refuses even a sub-picounit adjacency asymmetry", () => {
  assert.throws(() => graphLaplacian({ adjacency: [[0, 1], [1 + 5e-13, 0]] }), /symmetric/u);
  assert.deepEqual(graphLaplacian({ adjacency: [[0, 1], [1, 0]] }).laplacian, [[1, -1], [-1, 1]]);
});

test("exact Ising ground state does not conflate distinct energies as degeneracy", () => {
  const field = 2.5e-13;
  const ground = exactIsingGroundState({ fields: [field] });
  assert.equal(ground.energy, -field);
  assert.deepEqual(ground.spins, [-1]);
  assert.equal(ground.degeneracy, 1);
  assert.equal(ground.evaluatedStates, 2);
});

test("internal Quantum Ising reference agrees with exact one-spin energies and ground-state probability", () => {
  const field = 2.5e-13;
  const simulation = executeGaussIsingQaoaSimulation({
    problem: { problemId: "tiny-isolated-spin", fields: [field], couplings: [] },
    parameterSets: [{ parameterSetId: "identity", gammaMicroradians: [0], betaMicroradians: [0] }],
  });
  const candidate = simulation.candidates[0];
  assert.equal(candidate.groundStateEnergy, -field);
  assert.equal(candidate.groundStateMask, 1);
  assert.equal(candidate.approximationGap, field);
  assert(Math.abs(candidate.groundStateProbability - 0.5) < 1e-14);
  assert.equal(simulation.exactGroundStateEnergy, -field);
});
