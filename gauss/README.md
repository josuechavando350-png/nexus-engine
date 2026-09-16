# GAUSS — Scientific Decision Kernel

GAUSS is the NEXUS-owned scientific decision kernel. Its architectural target remains 800 executable operators in eight scientific domains, with 100 target operators per domain: mathematics, physics and complex systems, computer science, statistics and probability, decision theory, causal and experimental inference, control and dynamics, and information theory.

**Status by Git revision:** `main` has **23 merged executable operators** (through bounded discrete EVaR). The draft `feat/gauss-batch-001-to-200` branch registers **40 executable operators**, including eight bounded graph algorithms and nine distinct statistical operators. A draft count is **not** a certified delivery. The first batch target is **200**, not 40; `BATCH_001_200.md` defines its strict completion gate. Unknown operator IDs fail closed, and an executable operator is not equivalent to an entire conceptual layer from `SPEC_ALIGNMENT.md`.

## Existing scientific foundation

The merged Foundation/CVaR/EVaR operators cover one-dimensional empirical Wasserstein-2 distance, Pareto frontier, graph Laplacian, H0 persistent homology, Takens embedding, Ising energy and exact bounded ground state, Wilson interval, Brier score, seeded bootstrap, expected utility, minimax regret, weighted CVaR, weighted EVaR, difference-in-differences, normalized Hájek IPW ATE, finite-horizon scalar LQR, Euler–Maruyama, Shannon entropy, mutual information, Rényi divergence, bounded exact knapsack and finite-trace temporal verification.

H0 reports essential, finite and zero-length intervals with a bounded graph filtration, and explicitly refuses persistence sums that overflow. EVaR accepts explicit discrete scenarios and uses stable exponential tilting within a KL budget; its independent Chernoff and binary KL-ball tests concern only the supplied distribution. CVaR and EVaR are not calibrated predictions of customer outcomes or full Wasserstein distributionally robust optimization.

## Draft graph and routing operators (not merged)

- `GAUSS.CS.DIJKSTRA_SHORTEST_PATH.003`: shortest path with a verifiable route witness on finite nonnegative integer costs.
- `GAUSS.CS.MIN_SPANNING_FOREST.004`: minimum spanning forest with signed integer weights and disconnected components.
- `GAUSS.CS.MAX_FLOW_MIN_CUT.005`: integer maximum flow with a minimum-cut equality witness.
- `GAUSS.CS.STRONG_COMPONENTS.006`: deterministic strongly connected component partition.
- `GAUSS.CS.BIPARTITE_MATCHING.007`: maximum-cardinality bipartite assignment with witness pairs.
- `GAUSS.CS.DAG_SCHEDULE.008`: cycle-rejecting dependency schedule and critical-path makespan.
- `GAUSS.CS.TSP_HELD_KARP.009`: exact directed traveling-salesperson tour, restricted to at most 11 vertices and bounded integer costs.
- `GAUSS.INFO.PAGERANK.004`: stationary PageRank with dangling-node handling and explicit nonconvergence rejection.

The graph implementations have independent Bellman–Ford, exhaustive forest/cut/matching/TSP, transitive closure, recursive schedule and linear-equation PageRank oracles. They accept supplied abstract graphs, **not live freight/customs routes or real delivery promises**.

## Draft statistical and measurement operators (not merged)

- `GAUSS.STATS.WLS_LINE.004`: weighted least-squares line using bounded integer observations and weights; no causal interpretation.
- `GAUSS.STATS.ISOTONIC_PAV.005`: monotonic weighted least-squares calibration by pool-adjacent-violators.
- `GAUSS.STATS.BH_FDR.006`: Benjamini–Hochberg step-up discoveries and adjusted p-values; statistical FDR control depends on appropriate dependence assumptions.
- `GAUSS.STATS.PAIRED_PERMUTATION.007`: exact bounded paired sign-flip null enumeration; validity depends on sign-symmetry/exchangeability, not merely a small p-value.
- `GAUSS.STATS.FISHER_EXACT.008`: conditional two-sided 2×2 Fisher test with BigInt combinatorial counts and finite probability output.
- `GAUSS.STATS.KAPLAN_MEIER.009`: right-censored Kaplan–Meier curve; inference requires noninformative censoring and suitable sampling.
- `GAUSS.STATS.THEIL_SEN.010`: robust median-of-pairwise-slopes line with median intercept.
- `GAUSS.STATS.SPLIT_CONFORMAL.011`: absolute-residual split-conformal interval with correct `n+1` rank; finite-sample marginal coverage requires exchangeable calibration/test data and a fixed predictor.
- `GAUSS.STATS.SPRT_BERNOULLI.012`: Bernoulli sequential likelihood-ratio boundaries and first crossing, not a guarantee of an outcome in a specific case.

The draft implementations include independent normal-equation, exhaustive monotone-fit, BH suffix, signed-enumeration, hypergeometric, risk-set, pairwise median, quantile-rank and sequential-prefix oracles. All use bounded inputs and reject malformed/unsupported conditions; **none establishes real-world effectiveness without appropriate, independently collected outcomes**.

## Connected proof path

```text
WALLE adapter
  -> NEXUS GAUSS CLI
    -> GAUSS scientific kernel
      -> Nexus Quantum internal Ising/QAOA statevector simulator
    -> hash-bound GAUSS report
  -> independent WALLE replay and fail-closed evidence checks
```

`walle/adapters/gauss.sh` verifies a clean source tree, checks source syntax, runs the full GAUSS test suite and NEXUS CLI against the **currently registered fixture**, independently replays every operator output and Quantum receipt, and verifies source identity after execution. The fixture must execute **every registered ID exactly once**. The batch adds rehashed-forgery tests for all 17 graph/statistics outputs, not just checks that a hash looks valid.

Quantum calculates an actual internal statevector for a small Ising subproblem. `hardwareExecution=false` and `quantumAdvantageClaimAllowed=false`: no physical QPU use, proven speedup, or universal real-world effectiveness is claimed.

## Infrastructure and execution

No new external API, database, queue, network service, secret, package dependency or customer deployment is introduced. Run the connected check with:

```bash
WALLE_GAUSS_EVIDENCE_ROOT=/tmp/gauss-proof bash walle/adapters/gauss.sh
```

Or run the controlled fixture directly:

```bash
node scripts/nexus-gauss.mjs gauss/fixtures/selftest-problem.json
```

The batch stays draft and unmerged until the full 200-operator gate is satisfied or the owner explicitly authorizes a revised delivery boundary. No metric here is a prospective customer-outcome or 100% effectiveness claim.
