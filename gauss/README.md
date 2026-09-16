# GAUSS — Scientific Decision Kernel

GAUSS is the NEXUS-owned scientific kernel. Its architectural target is 800 distinct executable operators in eight domains, 100 per domain: mathematics, physics and complex systems, computer science, statistics and probability, decision theory, causal and experimental inference, control and dynamics, and information theory.

**Revision-scoped status:** the draft of PR #380 registers and fixtures **200** bounded executable scientific operators (the previously connected 116 plus 84 additions). A draft's count is not a merge, and a connected proof on an earlier SHA does not certify later changes. Read `gaussRegistrySummary()` on the actual revision; `BATCH_001_200.md` specifies the exact same-SHA release gate. A GAUSS operator does not by itself certify a full conceptual layer of `SPEC_ALIGNMENT.md`.

## Original scientific foundation

The merged Foundation/CVaR/EVaR operators include empirical Wasserstein-2, Pareto frontier, Laplacian, H0 persistent homology, Takens, Ising energy and exact bounded ground state, Wilson interval, Brier, seeded bootstrap, expected utility, minimax regret, discrete CVaR and EVaR, difference-in-differences, normalized Hájek IPW ATE, finite-horizon scalar LQR, Euler–Maruyama, Shannon entropy, mutual information, Rényi divergence, exact bounded knapsack and finite-trace temporal verification. H0, CVaR and EVaR are defined on explicit bounded inputs, without real-world outcome or distributionally robust optimization guarantees.

## First batch implementation (draft until certified and merged)

The next 93 already connected operators cover graph optimization, inferential statistics, numerical linear algebra, advanced graphs, discrete optimization, finite stochastic decisions, exact bounded number theory, control and computational geometry. The final 84 comprise 12 graph combinatorics, 12 signal processing, 12 descriptive statistics, 12 polynomial algebra, 12 integer arithmetic, 12 structural graphs, and 12 discrete information measures. Their separate implementations, deterministic fixture entries, independent oracle tests, malformed-input rejection, and WALLE replay/falsification checks are located under `gauss/core/`, `gauss/fixtures/` and `gauss/tests/`. The entire batch may be accepted only after the same final SHA passes all applicable CI, independent artifact audit, and review gates detailed in `BATCH_001_200.md`.

The reference Ising task calls a **classical statevector simulation** in Nexus Quantum and is bound to GAUSS problem and output hashes; this does not use a physical QPU. No new external APIs, database, queue, secret, service, package dependency, production client mutation or deployment is needed for this controlled batch. Outputs describe only supplied mathematical inputs; they do not establish effectiveness in client businesses.

## Proof entry points

```bash
node --test gauss/tests/*.test.mjs
WALLE_GAUSS_EVIDENCE_ROOT=/tmp/gauss-proof bash walle/adapters/gauss.sh
node scripts/nexus-gauss.mjs gauss/fixtures/selftest-problem.json
```
