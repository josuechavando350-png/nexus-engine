# GAUSS — Scientific Decision Kernel

GAUSS is the NEXUS-owned scientific kernel. Its current internal architectural target remains 800 distinct executable operators in eight domains, 100 per domain: mathematics, physics and complex systems, computer science, statistics and probability, decision theory, causal and experimental inference, control and dynamics, and information theory. The separate user-requested roadmap targets 1,000 operators; this internal registry target has not yet been reconciled and must not be presented as 1,000 implemented.

**Revision-scoped status:** `main` contains the audited first 200 operators as of base `ff1115f`. This draft extends the registry and connected proof to **202 distinct bounded executable operators**, but those two additions do not count as integrated until this exact revision passes review and is merged. Read `gaussRegistrySummary()` on the actual revision; prior GAUSS proof on another SHA does not certify subsequent changes. A GAUSS operator does not by itself certify a full conceptual layer of `SPEC_ALIGNMENT.md`.

## Original scientific foundation

The merged Foundation/CVaR/EVaR operators include empirical Wasserstein-2, Pareto frontier, Laplacian, H0 persistent homology, Takens, Ising energy and exact bounded ground state, Wilson interval, Brier, seeded bootstrap, expected utility, minimax regret, discrete CVaR and EVaR, difference-in-differences, normalized Hájek IPW ATE, finite-horizon scalar LQR, Euler–Maruyama, Shannon entropy, mutual information, Rényi divergence, exact bounded knapsack and finite-trace temporal verification. H0, CVaR and EVaR are defined on explicit bounded inputs, without real-world outcome or distributionally robust optimization guarantees.

## First 200: preserved historical baseline

The first 200 connected operators cover graph optimization, inferential statistics, numerical linear algebra, advanced graphs, discrete optimization, finite stochastic decisions, exact bounded number theory, control and computational geometry. The final 84 comprise 12 graph combinatorics, 12 signal processing, 12 descriptive statistics, 12 polynomial algebra, 12 integer arithmetic, 12 structural graphs, and 12 discrete information measures. Their implementations and original deterministic 200-task JSON fixture remain unchanged; see `BATCH_001_200.md` for their specific release gate.

## Operators 201–202 (draft)

- `GAUSS.MATH.CRT_GENERAL.059` solves bounded congruences with **noncoprime** moduli, detects inconsistent systems and yields a canonical solution modulo their least common multiple. This extends beyond the earlier pairwise-coprime CRT operator; integer strings prevent false precision.
- `GAUSS.MATH.FINITE_FIELD_MATRIX_INVERSE.060` computes complete square-matrix inverses over verified small prime fields or reports singularity; this is distinct from the existing scalar modular inverse. Dimensions are capped at 12 and primes at 65,521.

`gauss/core/foundation-fixture.mjs` explicitly composes the immutable 200-task fixture with the two new task definitions, writes the resulting 202-task problem **outside Git**, and binds it to the WALLE report hash. The generalized CRT is tested against 240 independent exhaustive small-modulus oracles; matrix inverses against 250 independent Leibniz determinants and two-sided products. WALLE independently checks the new fixture results and rejects modified results even if hashes are recomputed. This is finite deterministic validation, not proof of error-free software, unlimited precision or physical quantum execution.

The reference Ising task calls a **classical statevector simulation** in Nexus Quantum and is bound to GAUSS problem and output hashes; this does not use a physical QPU. No math package, new external API, database, queue, secret, service, client change or deployment is needed. Outputs describe only supplied mathematical inputs; they do not establish effectiveness in client businesses.

## Proof entry points

```bash
node --test gauss/tests/*.test.mjs
WALLE_GAUSS_EVIDENCE_ROOT="$(mktemp -d)" bash walle/adapters/gauss.sh
node gauss/core/foundation-fixture.mjs --out /tmp/gauss-202-fixture.json
node scripts/nexus-gauss.mjs /tmp/gauss-202-fixture.json
```

Never merge this draft while the exact final head SHA has pending or failed applicable checks or unresolved production-preview isolation concerns.
