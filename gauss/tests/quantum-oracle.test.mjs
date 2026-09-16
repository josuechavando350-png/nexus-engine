import assert from "node:assert/strict";
import test from "node:test";

import { executeGaussIsingQaoaSimulation } from "../../seo-avengers-2500/quantum-runtime/gauss-ising-qaoa-simulator.mjs";

function spin(mask, index) {
  return (mask & (1 << index)) ? -1 : 1;
}

function classicalEnergy(problem, mask) {
  return problem.offset
    + problem.fields.reduce((sum, field, index) => sum + field * spin(mask, index), 0)
    + problem.couplings.reduce((sum, edge) => sum + edge.value * spin(mask, edge.i) * spin(mask, edge.j), 0);
}

// Independent reference: construct the entire dense tensor-product mixing
// unitary, not the production simulator's in-place qubit-pair update.
function denseUnitaryOracle(problem, parameters) {
  const qubitCount = problem.fields.length;
  const stateCount = 2 ** qubitCount;
  let amplitudes = Array.from({ length: stateCount }, () => ({ real: 1 / Math.sqrt(stateCount), imaginary: 0 }));

  for (let depth = 0; depth < parameters.gammaMicroradians.length; depth += 1) {
    const gamma = parameters.gammaMicroradians[depth] / 1_000_000;
    const beta = parameters.betaMicroradians[depth] / 1_000_000;
    amplitudes = amplitudes.map((amplitude, mask) => {
      const phase = -gamma * classicalEnergy(problem, mask);
      return {
        real: amplitude.real * Math.cos(phase) - amplitude.imaginary * Math.sin(phase),
        imaginary: amplitude.real * Math.sin(phase) + amplitude.imaginary * Math.cos(phase),
      };
    });
    const before = amplitudes;
    amplitudes = Array.from({ length: stateCount }, (_, row) => {
      let real = 0;
      let imaginary = 0;
      for (let col = 0; col < stateCount; col += 1) {
        const flippedQubits = (row ^ col).toString(2).replace(/0/gu, "").length;
        const unchangedQubits = qubitCount - flippedQubits;
        const magnitude = Math.cos(beta) ** unchangedQubits * Math.sin(beta) ** flippedQubits;
        const phase = flippedQubits % 4;
        const factorReal = [1, 0, -1, 0][phase] * magnitude;
        const factorImaginary = [0, -1, 0, 1][phase] * magnitude;
        real += factorReal * before[col].real - factorImaginary * before[col].imaginary;
        imaginary += factorReal * before[col].imaginary + factorImaginary * before[col].real;
      }
      return { real, imaginary };
    });
  }

  const probabilities = amplitudes.map(({ real, imaginary }) => real * real + imaginary * imaginary);
  const energies = probabilities.map((_, mask) => classicalEnergy(problem, mask));
  const groundStateEnergy = Math.min(...energies);
  return {
    expectedEnergy: probabilities.reduce((sum, probability, index) => sum + probability * energies[index], 0),
    groundStateEnergy,
    groundStateProbability: probabilities.reduce((sum, probability, index) => sum + (
      Math.abs(energies[index] - groundStateEnergy) <= 1e-12 ? probability : 0
    ), 0),
    probabilityMass: probabilities.reduce((sum, probability) => sum + probability, 0),
  };
}

let seed = 17923;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
}

test("QAOA statevector matches independent dense unitaries on 60 seeded Ising problems", () => {
  for (let caseId = 0; caseId < 60; caseId += 1) {
    const count = 1 + Math.floor(random() * 3);
    const fields = Array.from({ length: count }, () => Math.round((random() * 2 - 1) * 6) / 4);
    const couplings = [];
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        if (random() < 0.7) couplings.push({ i, j, value: Math.round((random() * 2 - 1) * 6) / 4 });
      }
    }
    const problem = {
      problemId: `oracle-case-${caseId}`,
      fields,
      couplings,
      offset: Math.round((random() * 2 - 1) * 4) / 4,
    };
    const depth = 1 + Math.floor(random() * 3);
    const parameters = {
      parameterSetId: "test",
      gammaMicroradians: Array.from({ length: depth }, () => Math.floor(random() * 3_000_000)),
      betaMicroradians: Array.from({ length: depth }, () => Math.floor(random() * 3_000_000)),
    };
    const receipt = executeGaussIsingQaoaSimulation({ problem, parameterSets: [parameters] });
    const reference = denseUnitaryOracle(problem, parameters);
    const actual = receipt.candidates[0];
    for (const key of ["expectedEnergy", "groundStateEnergy", "groundStateProbability"]) {
      assert(Math.abs(actual[key] - reference[key]) < 1e-9, `case ${caseId} ${key}: ${actual[key]} vs ${reference[key]}`);
    }
    assert(Math.abs(reference.probabilityMass - 1) < 1e-9);
    assert(actual.approximationGap >= -1e-9);
    assert.equal(receipt.hardwareExecution, false);
    assert.equal(receipt.quantumAdvantageClaimAllowed, false);
  }
});

test("zero QAOA mixing angle preserves uniform probabilities despite cost phases", () => {
  const problem = {
    problemId: "zero-mixer",
    fields: [1.5, -0.5, 0.75],
    couplings: [{ i: 0, j: 1, value: 1 }, { i: 1, j: 2, value: -0.75 }],
    offset: 2,
  };
  const parameters = {
    parameterSetId: "beta-zero",
    gammaMicroradians: [1122334, 2233445],
    betaMicroradians: [0, 0],
  };
  const receipt = executeGaussIsingQaoaSimulation({ problem, parameterSets: [parameters] });
  const energies = Array.from({ length: 8 }, (_, mask) => classicalEnergy(problem, mask));
  const expectedUniformEnergy = energies.reduce((sum, energy) => sum + energy, 0) / energies.length;
  const groundStateEnergy = Math.min(...energies);
  const expectedGroundProbability = energies.filter((energy) => Math.abs(energy - groundStateEnergy) <= 1e-12).length / energies.length;
  assert(Math.abs(receipt.selectedExpectedEnergy - expectedUniformEnergy) < 1e-9);
  assert(Math.abs(receipt.candidates[0].groundStateProbability - expectedGroundProbability) < 1e-9);
});
