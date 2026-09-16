import { deepFreeze } from "./common.mjs";
import { empiricalWasserstein2, graphLaplacian, paretoFrontier } from "./layers/math.mjs";
import { zeroDimensionalPersistence } from "./layers/persistence.mjs";
import { exactIsingGroundState, isingEnergy, takensEmbedding } from "./layers/physics.mjs";
import { bootstrapMeanInterval, brierScore, wilsonInterval } from "./layers/statistics.mjs";
import { expectedUtility, minimaxRegret } from "./layers/decision.mjs";
import { discreteConditionalValueAtRisk } from "./layers/risk.mjs";
import { differenceInDifferences, inversePropensityWeightedATE } from "./layers/causal.mjs";
import { eulerMaruyama, finiteHorizonScalarLQR } from "./layers/control.mjs";
import { mutualInformation, renyiDivergence, shannonEntropy } from "./layers/information.mjs";
import { exactBinaryKnapsack, verifyRequestEventuallyCertification } from "./layers/computing.mjs";

export const GAUSS_DOMAINS = deepFreeze([
  { id: "MATHEMATICS", targetLayers: 100 },
  { id: "PHYSICS_COMPLEX_SYSTEMS", targetLayers: 100 },
  { id: "COMPUTER_SCIENCE", targetLayers: 100 },
  { id: "STATISTICS_PROBABILITY", targetLayers: 100 },
  { id: "DECISION_THEORY", targetLayers: 100 },
  { id: "CAUSAL_EXPERIMENTAL", targetLayers: 100 },
  { id: "CONTROL_DYNAMICS", targetLayers: 100 },
  { id: "INFORMATION_THEORY", targetLayers: 100 },
]);

const definitions = [
  ["GAUSS.MATH.WASSERSTEIN2.001", "MATHEMATICS", "Empirical one-dimensional Wasserstein-2 distance", empiricalWasserstein2],
  ["GAUSS.MATH.PARETO.002", "MATHEMATICS", "Exact Pareto frontier under mixed MAX/MIN objectives", paretoFrontier],
  ["GAUSS.MATH.GRAPH_LAPLACIAN.003", "MATHEMATICS", "Weighted undirected graph Laplacian", graphLaplacian],
  ["GAUSS.MATH.PERSISTENCE_H0.004", "MATHEMATICS", "H0 persistent homology of a weighted graph sublevel filtration", zeroDimensionalPersistence],
  ["GAUSS.PHYSICS.TAKENS.001", "PHYSICS_COMPLEX_SYSTEMS", "Takens time-delay embedding", takensEmbedding],
  ["GAUSS.PHYSICS.ISING_ENERGY.002", "PHYSICS_COMPLEX_SYSTEMS", "Classical Ising Hamiltonian energy", isingEnergy],
  ["GAUSS.PHYSICS.ISING_EXACT_GROUND.003", "PHYSICS_COMPLEX_SYSTEMS", "Exact bounded Ising ground-state enumeration", exactIsingGroundState],
  ["GAUSS.STATS.WILSON.001", "STATISTICS_PROBABILITY", "Wilson binomial confidence interval", wilsonInterval],
  ["GAUSS.STATS.BRIER.002", "STATISTICS_PROBABILITY", "Brier probability calibration score", brierScore],
  ["GAUSS.STATS.BOOTSTRAP_MEAN.003", "STATISTICS_PROBABILITY", "Seeded percentile bootstrap interval for a mean", bootstrapMeanInterval],
  ["GAUSS.DECISION.EXPECTED_UTILITY.001", "DECISION_THEORY", "Expected utility under a normalized discrete distribution", expectedUtility],
  ["GAUSS.DECISION.MINIMAX_REGRET.002", "DECISION_THEORY", "Minimax regret action selection", minimaxRegret],
  ["GAUSS.DECISION.CVAR_DISCRETE.003", "DECISION_THEORY", "Weighted discrete conditional value at risk for supplied losses", discreteConditionalValueAtRisk],
  ["GAUSS.CAUSAL.DID.001", "CAUSAL_EXPERIMENTAL", "Difference-in-differences point estimate", differenceInDifferences],
  ["GAUSS.CAUSAL.IPW_ATE.002", "CAUSAL_EXPERIMENTAL", "Normalized inverse-propensity weighted ATE (Hajek-style)", inversePropensityWeightedATE],
  ["GAUSS.CONTROL.SCALAR_LQR.001", "CONTROL_DYNAMICS", "Finite-horizon discrete scalar LQR", finiteHorizonScalarLQR],
  ["GAUSS.CONTROL.EULER_MARUYAMA.002", "CONTROL_DYNAMICS", "Seeded Euler-Maruyama SDE integration", eulerMaruyama],
  ["GAUSS.INFO.SHANNON.001", "INFORMATION_THEORY", "Shannon entropy", shannonEntropy],
  ["GAUSS.INFO.MUTUAL_INFORMATION.002", "INFORMATION_THEORY", "Discrete mutual information", mutualInformation],
  ["GAUSS.INFO.RENYI.003", "INFORMATION_THEORY", "Renyi divergence", renyiDivergence],
  ["GAUSS.CS.KNAPSACK_EXACT.001", "COMPUTER_SCIENCE", "Exact branch-and-bound binary knapsack", exactBinaryKnapsack],
  ["GAUSS.CS.LTL_REQUEST_EVENTUALLY_CERT.002", "COMPUTER_SCIENCE", "Finite-trace verification of G(request -> F(certification))", verifyRequestEventuallyCertification],
];

const domainIds = new Set(GAUSS_DOMAINS.map((domain) => domain.id));
const ids = new Set();
export const GAUSS_IMPLEMENTED_LAYERS = deepFreeze(definitions.map(([id, domain, description, execute]) => {
  if (ids.has(id)) throw new Error(`duplicate GAUSS layer id:${id}`);
  if (!domainIds.has(domain)) throw new Error(`unknown GAUSS domain:${domain}`);
  if (typeof execute !== "function") throw new Error(`GAUSS layer is not executable:${id}`);
  ids.add(id);
  return { id, domain, description, execute };
}));

const byId = new Map(GAUSS_IMPLEMENTED_LAYERS.map((layer) => [layer.id, layer]));

export function getGaussLayer(layerId) {
  return byId.get(layerId) ?? null;
}

export function gaussRegistrySummary() {
  const implementedByDomain = Object.fromEntries(GAUSS_DOMAINS.map((domain) => [domain.id, 0]));
  for (const layer of GAUSS_IMPLEMENTED_LAYERS) implementedByDomain[layer.domain] += 1;
  return deepFreeze({
    targetLayerCount: GAUSS_DOMAINS.reduce((sum, domain) => sum + domain.targetLayers, 0),
    implementedLayerCount: GAUSS_IMPLEMENTED_LAYERS.length,
    implementedByDomain,
    domains: GAUSS_DOMAINS,
  });
}
