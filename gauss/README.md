# GAUSS — Scientific Decision Kernel

GAUSS is the NEXUS-owned scientific decision kernel. Its architectural target remains 800 executable operators in eight scientific domains, with 100 target operators per domain: mathematics, physics and complex systems, computer science, statistics and probability, decision theory, causal and experimental inference, control and dynamics, and information theory.

**Status by Git revision:** obtain the actual executable count from `gaussRegistrySummary()` on the SHA under examination. The merged registry in `main` and an open draft branch are different things. The first batch target is **200**, not any interim count; `BATCH_001_200.md` defines its strict completion gate. Unknown IDs fail closed, and an executable operator is not equivalent to an entire conceptual layer from `SPEC_ALIGNMENT.md`.

## Existing scientific foundation

The merged Foundation/CVaR/EVaR operators cover one-dimensional empirical Wasserstein-2 distance, Pareto frontier, graph Laplacian, H0 persistent homology, Takens embedding, Ising energy and exact bounded ground state, Wilson interval, Brier score, seeded bootstrap, expected utility, minimax regret, weighted CVaR, weighted EVaR, difference-in-differences, normalized Hájek IPW ATE, finite-horizon scalar LQR, Euler–Maruyama, Shannon entropy, mutual information, Rényi divergence, bounded exact knapsack and finite-trace temporal verification.

H0 reports essential, finite and zero-length intervals with a bounded graph filtration, and explicitly refuses persistence sums that overflow. EVaR accepts explicit discrete scenarios and uses stable exponential tilting within a KL budget; its independent Chernoff and binary KL-ball tests concern only the supplied distribution. CVaR and EVaR are not calibrated predictions of customer outcomes or full Wasserstein distributionally robust optimization.

## Draft batch capabilities (not merged)

The draft implements bounded graph optimization (shortest paths, spanning forest, max-flow/min-cut, strongly connected components, bipartite matching, DAG scheduling, Held–Karp TSP, PageRank), nine distinct statistical inference/measurement operators, and seven native numerical linear-algebra/Fourier algorithms. Every proposed operator must be connected to the registry, the full fixture and WALLE falsification tests before acceptance; the final 200-operator milestone must pass all gates on one exact SHA. Standalone or older-SHA green tests never certify later commits.

No external API, database, queue, secret, service, package dependency, customer mutation or physical-QPU assertion is introduced by this draft. Mathematical outputs apply only to the provided bounded data unless separately validated against real observations.

## Proof entry points

```bash
WALLE_GAUSS_EVIDENCE_ROOT=/tmp/gauss-proof bash walle/adapters/gauss.sh
node scripts/nexus-gauss.mjs gauss/fixtures/selftest-problem.json
```
