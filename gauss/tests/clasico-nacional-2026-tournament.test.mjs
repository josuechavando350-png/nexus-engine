import assert from "node:assert/strict";
import test from "node:test";

import { executeGaussProblem } from "../core/problem.mjs";
import { contributeNexusQuantum } from "../core/quantum-contributor.mjs";

// Immutable pre-match snapshot, not a live feed or a validated forecasting model.
// Club America official match centre, retrieved 2026-09-18:
// https://www.clubamerica.com.mx/partidos/temporada-2026-2027-1-liga-bbva-mx-9-club-america-vs-guadalajara-2641250
const SNAPSHOT = Object.freeze({
  asOf: "2026-09-18",
  fixture: "America vs Guadalajara, Apertura 2026 J9, 2026-09-19",
  source: "https://www.clubamerica.com.mx/partidos/temporada-2026-2027-1-liga-bbva-mx-9-club-america-vs-guadalajara-2641250",
  america: Object.freeze({ played: 7, points: 16, scored: 15, conceded: 6 }),
  guadalajara: Object.freeze({ played: 8, points: 17, scored: 15, conceded: 6 }),
});

function assertProbabilityDistribution(values) {
  assert(Array.isArray(values) && values.length === 33);
  for (const value of values) assert(Number.isFinite(value) && value >= 0 && value <= 1);
  assert(Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < 1e-10);
}

function outcomes(home, away) {
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let modalProbability = -1;
  let modalScore = null;
  for (let h = 0; h < home.length; h += 1) {
    for (let a = 0; a < away.length; a += 1) {
      const probability = home[h] * away[a];
      if (h > a) homeWin += probability;
      else if (h === a) draw += probability;
      else awayWin += probability;
      if (probability > modalProbability) {
        modalProbability = probability;
        modalScore = `${h}-${a}`;
      }
    }
  }
  const total = homeWin + draw + awayWin;
  assert(Math.abs(total - 1) < 1e-10);
  return { homeWin, draw, awayWin, modalScore, modalScoreProbability: modalProbability };
}

// Ising energies are merely an encoding of already-calculated probabilities.
// This is NOT an independent prediction, quantum hardware run, or quantum advantage.
function encodeIsing(probabilities) {
  const energies = [...probabilities.map((p) => -Math.log(p))];
  energies.push(Math.max(...energies) + 8); // disallow fourth two-spin state
  const [e00, e01, e10, e11] = energies;
  return {
    fields: [
      (e00 - e01 + e10 - e11) / 4,
      (e00 + e01 - e10 - e11) / 4,
    ],
    couplings: [{ i: 0, j: 1, value: (e00 - e01 - e10 + e11) / 4 }],
    offset: (e00 + e01 + e10 + e11) / 4,
  };
}

test("Clasico 2026: sourced GAUSS distribution, Quantum Ising receipt, WALLE/AXIOMA-compatible proof", async () => {
  assert.equal(SNAPSHOT.america.points, 16);
  assert.equal(SNAPSHOT.guadalajara.points, 17);
  assert(SNAPSHOT.america.played > 0 && SNAPSHOT.guadalajara.played > 0);
  const meanHomeGoals = ((SNAPSHOT.america.scored / SNAPSHOT.america.played)
    + (SNAPSHOT.guadalajara.conceded / SNAPSHOT.guadalajara.played)) / 2;
  const meanAwayGoals = ((SNAPSHOT.guadalajara.scored / SNAPSHOT.guadalajara.played)
    + (SNAPSHOT.america.conceded / SNAPSHOT.america.played)) / 2;
  // Thirty-two independent equal-probability scoring opportunities are an explicit
  // illustrative binomial assumption; no fitted model or calibration is claimed.
  const opportunities = 32;
  const problem = {
    schemaVersion: 1,
    problemId: "clasico-2026-gauss-binomial-v1",
    objective: "Pre-match illustrative outcome distribution from official 2026-09-18 season goals; no accuracy claim",
    tasks: [
      { taskId: "america-goals", layerId: "GAUSS.STATS.POISSON_BINOMIAL.021", input: {
        probabilities: Array(opportunities).fill(meanHomeGoals / opportunities),
      } },
      { taskId: "guadalajara-goals", layerId: "GAUSS.STATS.POISSON_BINOMIAL.021", input: {
        probabilities: Array(opportunities).fill(meanAwayGoals / opportunities),
      } },
    ],
  };
  const gauss = await executeGaussProblem(problem, { quantumContributor: contributeNexusQuantum });
  assert.equal(gauss.status, "PASS", gauss.errors.join("; "));
  assert.equal(gauss.executedLayerCount, 2);
  assert.equal(gauss.quantumContribution.status, "NOT_APPLICABLE");
  const home = gauss.taskResults[0].output.probabilities;
  const away = gauss.taskResults[1].output.probabilities;
  assertProbabilityDistribution(home);
  assertProbabilityDistribution(away);
  assert(Math.abs(home.reduce((sum, p, goals) => sum + p * goals, 0) - meanHomeGoals) < 1e-10);
  assert(Math.abs(away.reduce((sum, p, goals) => sum + p * goals, 0) - meanAwayGoals) < 1e-10);
  const forecast = outcomes(home, away);
  const threeWay = [forecast.homeWin, forecast.draw, forecast.awayWin];
  const maxIndex = threeWay.indexOf(Math.max(...threeWay));
  const labels = ["AMERICA", "EMPATE", "GUADALAJARA"];

  const optimized = await executeGaussProblem({
    schemaVersion: 1,
    problemId: "clasico-2026-quantum-ising-v1",
    objective: "Confirm exact Ising energy optimum reproduces, but does not independently forecast, GAUSS three-way maximum",
    tasks: [{ taskId: "scenario-ising", layerId: "GAUSS.PHYSICS.ISING_EXACT_GROUND.003", input: encodeIsing(threeWay) }],
  }, { quantumContributor: contributeNexusQuantum });
  assert.equal(optimized.status, "PASS", optimized.errors.join("; "));
  assert.equal(optimized.quantumContribution.status, "EXECUTED");
  assert.equal(optimized.quantumContribution.simulation.verdict, "PASS");
  assert.equal(optimized.quantumContribution.simulation.hardwareExecution, false);
  assert.equal(optimized.quantumContribution.simulation.quantumAdvantageClaimAllowed, false);
  const spins = optimized.taskResults[0].output.spins;
  const winnerIndex = (spins[0] === -1 ? 1 : 0) + (spins[1] === -1 ? 2 : 0);
  assert.equal(winnerIndex, maxIndex);
  assert(winnerIndex < 3);

  // This test is run by walle/adapters/gauss.sh before its full 1000-task
  // GAUSS proof, AXIOMA 100000+3000 replay, and WALLE source-identity check.
  console.log(`CLASICO_TOURNAMENT_RESULT=${JSON.stringify({
    fixture: SNAPSHOT.fixture,
    snapshotAsOf: SNAPSHOT.asOf,
    source: SNAPSHOT.source,
    model: "illustrative 32-opportunity binomial; not trained or backtested",
    opportunities,
    expectedGoals: { america: meanHomeGoals, guadalajara: meanAwayGoals },
    probabilities: { america: forecast.homeWin, empate: forecast.draw, guadalajara: forecast.awayWin },
    modalScore: forecast.modalScore,
    modalScoreProbability: forecast.modalScoreProbability,
    mostProbableOutcome: labels[maxIndex],
    gaussReportSha256: gauss.reportSha256,
    quantumReportSha256: optimized.reportSha256,
    quantumReceiptSha256: optimized.quantumContribution.simulation.receiptSha256,
    quantumIsSimulatorOnly: true,
  })}`);
});
