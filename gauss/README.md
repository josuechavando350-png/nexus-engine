# GAUSS — Scientific Decision Kernel

GAUSS is the NEXUS-owned scientific decision kernel. Its architectural target remains 800 executable operators in eight scientific domains, with 100 target operators per domain: mathematics, physics and complex systems, computer science, statistics and probability, decision theory, causal and experimental inference, control and dynamics, and information theory.

**Status by Git revision:** `main` has 23 merged executable operators (through bounded discrete EVaR). The draft `feat/gauss-batch-001-to-200` branch registers **31 executable operators**, including eight new bounded graph algorithms. This draft count is not an accepted batch delivery or a certification. The first batch target is **200**, not 31; `BATCH_001_200.md` defines its strict completion gate. Unknown IDs fail closed, and an executable operator is not equivalent to an entire conceptual layer from `SPEC_ALIGNMENT.md`.

## Existing scientific foundation

The merged Foundation/CVaR/EVaR operators cover one-dimensional empirical Wasserstein-2 distance, Pareto frontier, graph Laplacian, H0 persistent homology, Takens embedding, Ising energy and exact bounded ground state, Wilson interval, Brier score, seeded bootstrap, expected utility, minimax regret, weighted CVaR, weighted EVaR, difference-in-differences, normalized Hájek IPW ATE, finite-horizon scalar LQR, Euler–Maruyama, Shannon entropy, mutual information, Rényi divergence, bounded exact knapsack and finite-trace temporal verification.

H0 reports essential, finite and zero-length intervals with a bounded graph filtration, and explicitly refuses persistence sums that overflow. EVaR accepts explicit discrete scenarios and uses stable exponential tilting within a KL budget; its independent Chernoff and binary KL-ball tests concern only the supplied distribution. CVaR and EVaR are not calibrated predictions of customer outcomes or full Wasserstein distributionally robust optimization.

## Draft batch graph capabilities (not merged)

- `GAUSS.CS.DIJKSTRA_SHORTEST_PATH.003`: shortest path with a verifiable route witness on finite nonnegative integer edge costs.
- `GAUSS.CS.MIN_SPANNING_FOREST.004`: minimum spanning forest with signed integer weights and explicit disconnected components.
- `GAUSS.CS.MAX_FLOW_MIN_CUT.005`: integer maximum flow with a minimum-cut equality witness.
- `GAUSS.CS.STRONG_COMPONENTS.006`: deterministic strongly connected component partition.
- `GAUSS.CS.BIPARTITE_MATCHING.007`: cardinality-maximal bipartite assignment with witness pairs.
- `GAUSS.CS.DAG_SCHEDULE.008`: cycle-rejecting dependency schedule and critical-path makespan.
- `GAUSS.CS.TSP_HELD_KARP.009`: exact directed traveling-salesperson tour, restricted to at most 11 stops and bounded integer costs.
- `GAUSS.INFO.PAGERANK.004`: stationary PageRank with dangling-node handling and explicit nonconvergence rejection.

The draft algorithms use Node.js standard library only and are tested against independent Bellman–Ford, exhaustive forest, exhaustive cut, transitive closure, exhaustive matching, recursive schedule, permutation TSP, and Gaussian-elimination PageRank oracles. A `PASS` on synthetic graphs does not mean that live freight/customs data exist or that travel time, cost or physical logistics are guaranteed.

## Connected proof path

```text
WALLE adapter
  -> NEXUS GAUSS CLI
    -> GAUSS scientific kernel
      -> Nexus Quantum internal Ising/QAOA statevector simulator
    -> hash-bound GAUSS report
  -> independent WALLE replay and fail-closed evidence checks
```

`walle/adapters/gauss.sh` verifies a clean source tree, checks the source syntax, runs the full GAUSS test suite and NEXUS CLI against the **currently registered fixture**, independently replays all operator outputs and the Quantum receipt, and verifies source identity after execution. The fixture must execute **every unique registry ID exactly once**. The draft batch adds rehashed-forgery tests for all eight new graph outputs; WALLE must reject each manipulated report.

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
