import { deepFreeze } from "./common.mjs";
import { empiricalWasserstein2, graphLaplacian, paretoFrontier } from "./layers/math.mjs";
import { zeroDimensionalPersistence } from "./layers/persistence.mjs";
import { exactIsingGroundState, isingEnergy, takensEmbedding } from "./layers/physics.mjs";
import { bootstrapMeanInterval, brierScore, wilsonInterval } from "./layers/statistics.mjs";
import { expectedUtility, minimaxRegret } from "./layers/decision.mjs";
import { discreteConditionalValueAtRisk } from "./layers/risk.mjs";
import { discreteEntropicValueAtRisk } from "./layers/entropic-risk.mjs";
import { differenceInDifferences, inversePropensityWeightedATE } from "./layers/causal.mjs";
import { eulerMaruyama, finiteHorizonScalarLQR } from "./layers/control.mjs";
import { mutualInformation, renyiDivergence, shannonEntropy } from "./layers/information.mjs";
import { exactBinaryKnapsack, verifyRequestEventuallyCertification } from "./layers/computing.mjs";
import {
  shortestPathDijkstra, minimumSpanningForest, maximumFlowMinimumCut,
  stronglyConnectedComponents, bipartiteMaximumMatching, directedAcyclicSchedule,
  exactTravelingSalesperson, stationaryPageRank,
} from "./layers/graph-optimization.mjs";
import {
  weightedLeastSquaresLine, weightedIsotonicRegression, benjaminiHochbergFdr,
  exactPairedSignPermutation, fisherExactTwoSided, kaplanMeierSurvival,
  theilSenLine, splitConformalInterval, bernoulliSequentialLikelihood,
} from "./layers/statistical-inference.mjs";
import {
  gaussianLinearSolve, pivotedLogDeterminant, choleskyDecomposition,
  conjugateGradientSolve, householderQrDecomposition, qrLeastSquaresSolve,
  radixTwoFourierTransform,
} from "./layers/numerical-linear-algebra.mjs";
import {
  bellmanFordSigned, floydWarshallAllPairs, articulationVertices,
  graphBridges, exactWeightedVertexCover, exactGraphColoring,
  minimumCostAssignment, weightedTreeDiameter, directedEulerTrail,
} from "./layers/graph-advanced.mjs";
import {
  weightedIntervalScheduling, matrixChainMultiplication, minimumCoinChange,
  exactSubsetSum, longestIncreasingSubsequence, levenshteinDistance,
  longestCommonSubsequence, optimalHuffmanLengths,
  optimalSuccessfulBinarySearchTree, minimumPalindromePartition,
  johnsonTwoMachineSchedule,
} from "./layers/discrete-optimization.mjs";

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
  ["GAUSS.DECISION.EVAR_DISCRETE.004", "DECISION_THEORY", "Bounded discrete entropic value at risk via KL-constrained exponential tilting", discreteEntropicValueAtRisk],
  ["GAUSS.CAUSAL.DID.001", "CAUSAL_EXPERIMENTAL", "Difference-in-differences point estimate", differenceInDifferences],
  ["GAUSS.CAUSAL.IPW_ATE.002", "CAUSAL_EXPERIMENTAL", "Normalized inverse-propensity weighted ATE (Hajek-style)", inversePropensityWeightedATE],
  ["GAUSS.CONTROL.SCALAR_LQR.001", "CONTROL_DYNAMICS", "Finite-horizon discrete scalar LQR", finiteHorizonScalarLQR],
  ["GAUSS.CONTROL.EULER_MARUYAMA.002", "CONTROL_DYNAMICS", "Seeded Euler-Maruyama SDE integration", eulerMaruyama],
  ["GAUSS.INFO.SHANNON.001", "INFORMATION_THEORY", "Shannon entropy", shannonEntropy],
  ["GAUSS.INFO.MUTUAL_INFORMATION.002", "INFORMATION_THEORY", "Discrete mutual information", mutualInformation],
  ["GAUSS.INFO.RENYI.003", "INFORMATION_THEORY", "Renyi divergence", renyiDivergence],
  ["GAUSS.CS.KNAPSACK_EXACT.001", "COMPUTER_SCIENCE", "Exact branch-and-bound binary knapsack", exactBinaryKnapsack],
  ["GAUSS.CS.LTL_REQUEST_EVENTUALLY_CERT.002", "COMPUTER_SCIENCE", "Finite-trace verification of G(request -> F(certification))", verifyRequestEventuallyCertification],
  ["GAUSS.CS.DIJKSTRA_SHORTEST_PATH.003", "COMPUTER_SCIENCE", "Bounded exact nonnegative shortest path with route witness", shortestPathDijkstra],
  ["GAUSS.CS.MIN_SPANNING_FOREST.004", "COMPUTER_SCIENCE", "Kruskal minimum spanning forest for signed integer edge weights", minimumSpanningForest],
  ["GAUSS.CS.MAX_FLOW_MIN_CUT.005", "COMPUTER_SCIENCE", "Edmonds-Karp integer max flow with min-cut certificate", maximumFlowMinimumCut],
  ["GAUSS.CS.STRONG_COMPONENTS.006", "COMPUTER_SCIENCE", "Tarjan strongly connected component partition", stronglyConnectedComponents],
  ["GAUSS.CS.BIPARTITE_MATCHING.007", "COMPUTER_SCIENCE", "Maximum cardinality bipartite assignment with matching witness", bipartiteMaximumMatching],
  ["GAUSS.CS.DAG_SCHEDULE.008", "COMPUTER_SCIENCE", "Topological project schedule and longest critical path in a DAG", directedAcyclicSchedule],
  ["GAUSS.CS.TSP_HELD_KARP.009", "COMPUTER_SCIENCE", "Exact bounded directed traveling-salesperson tour by Held-Karp DP", exactTravelingSalesperson],
  ["GAUSS.INFO.PAGERANK.004", "INFORMATION_THEORY", "Bounded stationary PageRank with explicit convergence criterion", stationaryPageRank],
  ["GAUSS.STATS.WLS_LINE.004", "STATISTICS_PROBABILITY", "Bounded weighted least-squares linear fit and residual witness", weightedLeastSquaresLine],
  ["GAUSS.STATS.ISOTONIC_PAV.005", "STATISTICS_PROBABILITY", "Weighted pool-adjacent-violators monotone regression", weightedIsotonicRegression],
  ["GAUSS.STATS.BH_FDR.006", "STATISTICS_PROBABILITY", "Benjamini-Hochberg multiple-testing FDR adjustment", benjaminiHochbergFdr],
  ["GAUSS.STATS.PAIRED_PERMUTATION.007", "STATISTICS_PROBABILITY", "Exact bounded two-sided paired sign-permutation inference", exactPairedSignPermutation],
  ["GAUSS.STATS.FISHER_EXACT.008", "STATISTICS_PROBABILITY", "Exact two-sided hypergeometric Fisher test using BigInt combinatorics", fisherExactTwoSided],
  ["GAUSS.STATS.KAPLAN_MEIER.009", "STATISTICS_PROBABILITY", "Right-censored Kaplan-Meier survival curve with tied events", kaplanMeierSurvival],
  ["GAUSS.STATS.THEIL_SEN.010", "STATISTICS_PROBABILITY", "Bounded robust median-slope Theil-Sen linear estimator", theilSenLine],
  ["GAUSS.STATS.SPLIT_CONFORMAL.011", "STATISTICS_PROBABILITY", "Finite split-conformal absolute-residual interval with n+1 rank", splitConformalInterval],
  ["GAUSS.STATS.SPRT_BERNOULLI.012", "STATISTICS_PROBABILITY", "Sequential Bernoulli likelihood-ratio decision with explicit boundaries", bernoulliSequentialLikelihood],
  ["GAUSS.MATH.GAUSSIAN_SOLVE.005", "MATHEMATICS", "Pivoted bounded linear-system solve with residual witness", gaussianLinearSolve],
  ["GAUSS.MATH.PIVOTED_LOGDET.006", "MATHEMATICS", "Signed log-determinant by bounded pivoted elimination", pivotedLogDeterminant],
  ["GAUSS.MATH.CHOLESKY.007", "MATHEMATICS", "Cholesky factorization with symmetric-positive-definite checks", choleskyDecomposition],
  ["GAUSS.MATH.CONJUGATE_GRADIENT.008", "MATHEMATICS", "Conjugate-gradient SPD linear solve with independent residual", conjugateGradientSolve],
  ["GAUSS.MATH.HOUSEHOLDER_QR.009", "MATHEMATICS", "Householder orthogonal-triangular factorization", householderQrDecomposition],
  ["GAUSS.STATS.QR_LEAST_SQUARES.013", "STATISTICS_PROBABILITY", "Numerically bounded least-squares fit using orthogonal QR factorization", qrLeastSquaresSolve],
  ["GAUSS.INFO.FFT_RADIX2.005", "INFORMATION_THEORY", "Radix-two complex Fourier transform with inverse and finite checks", radixTwoFourierTransform],
  ["GAUSS.CS.BELLMAN_FORD_SIGNED.010", "COMPUTER_SCIENCE", "Signed-weight single-source shortest path with reachable negative-cycle rejection", bellmanFordSigned],
  ["GAUSS.CS.FLOYD_WARSHALL.011", "COMPUTER_SCIENCE", "All-pairs shortest paths with negative-cycle detection", floydWarshallAllPairs],
  ["GAUSS.CS.ARTICULATION_VERTICES.012", "COMPUTER_SCIENCE", "Undirected articulation vertices using discovery/low-link invariants", articulationVertices],
  ["GAUSS.CS.BRIDGES.013", "COMPUTER_SCIENCE", "Undirected bridge-edge detection using low-link invariants", graphBridges],
  ["GAUSS.CS.WEIGHTED_VERTEX_COVER.014", "COMPUTER_SCIENCE", "Exact bounded minimum-weight vertex cover", exactWeightedVertexCover],
  ["GAUSS.CS.CHROMATIC_NUMBER.015", "COMPUTER_SCIENCE", "Exact bounded chromatic number and coloring witness", exactGraphColoring],
  ["GAUSS.CS.MIN_COST_ASSIGNMENT.016", "COMPUTER_SCIENCE", "Exact minimum-cost square assignment by subset DP", minimumCostAssignment],
  ["GAUSS.CS.WEIGHTED_TREE_DIAMETER.017", "COMPUTER_SCIENCE", "Weighted nonnegative tree diameter with route witness", weightedTreeDiameter],
  ["GAUSS.CS.DIRECTED_EULER_TRAIL.018", "COMPUTER_SCIENCE", "Directed Euler trail over distinct edge identities", directedEulerTrail],
  ["GAUSS.DECISION.WEIGHTED_INTERVAL_SCHEDULING.005", "DECISION_THEORY", "Exact reward-maximizing interval scheduling with conflict-free witness", weightedIntervalScheduling],
  ["GAUSS.CS.MATRIX_CHAIN.019", "COMPUTER_SCIENCE", "Exact minimum multiplication-order matrix-chain dynamic program", matrixChainMultiplication],
  ["GAUSS.DECISION.MIN_COIN_CHANGE.006", "DECISION_THEORY", "Unbounded minimum coin-change with exact amount witness", minimumCoinChange],
  ["GAUSS.CS.SUBSET_SUM.020", "COMPUTER_SCIENCE", "Exact bounded subset-sum existence and selected-index witness", exactSubsetSum],
  ["GAUSS.CS.LONGEST_INCREASING_SUBSEQUENCE.021", "COMPUTER_SCIENCE", "Strict longest increasing subsequence with indices and values", longestIncreasingSubsequence],
  ["GAUSS.CS.LEVENSHTEIN.022", "COMPUTER_SCIENCE", "Unicode-code-point Levenshtein edit distance", levenshteinDistance],
  ["GAUSS.CS.LONGEST_COMMON_SUBSEQUENCE.023", "COMPUTER_SCIENCE", "Exact longest common subsequence with witness", longestCommonSubsequence],
  ["GAUSS.INFO.HUFFMAN_CODE_LENGTHS.006", "INFORMATION_THEORY", "Optimal weighted binary prefix-code lengths and cost", optimalHuffmanLengths],
  ["GAUSS.CS.OPTIMAL_BST.024", "COMPUTER_SCIENCE", "Minimum weighted successful-search BST with root witness", optimalSuccessfulBinarySearchTree],
  ["GAUSS.CS.MIN_PALINDROME_PARTITION.025", "COMPUTER_SCIENCE", "Exact minimum partition into palindromic strings", minimumPalindromePartition],
  ["GAUSS.DECISION.JOHNSON_TWO_MACHINE.007", "DECISION_THEORY", "Two-machine flow-shop Johnson scheduling with makespan witness", johnsonTwoMachineSchedule],
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
