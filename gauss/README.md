# GAUSS — Scientific Decision Kernel

GAUSS is the NEXUS-owned scientific kernel. Its current internal architectural target remains 800 distinct executable operators in eight domains, 100 per domain: mathematics, physics and complex systems, computer science, statistics and probability, decision theory, causal and experimental inference, control and dynamics, and information theory. The separate user-requested roadmap targets 1,000 operators; this internal registry target has not yet been reconciled and must not be presented as 1,000 implemented.

**Revision-scoped status:** `main` contains the audited first 200 operators as of base `ff1115f`. This draft based on PR #384 registers **204 bounded executable operators**, but the four later additions do not count as integrated into `main` until the exact revision passes review and is merged. Codex separately reported 262 operators in unpushed local commits; those bytes have not been reconciled against this branch, so 204 is **not** evidence that the 263–462 batch is underway or complete. Read `gaussRegistrySummary()` on the actual revision; CI on another SHA does not certify subsequent changes. A GAUSS operator does not by itself certify a full conceptual layer of `SPEC_ALIGNMENT.md`.

## Original scientific foundation

The merged Foundation/CVaR/EVaR operators include empirical Wasserstein-2, Pareto frontier, Laplacian, H0 persistent homology, Takens, Ising energy and exact bounded ground state, Wilson interval, Brier, seeded bootstrap, expected utility, minimax regret, discrete CVaR and EVaR, difference-in-differences, normalized Hájek IPW ATE, finite-horizon scalar LQR, Euler–Maruyama, Shannon entropy, mutual information, Rényi divergence, exact bounded knapsack and finite-trace temporal verification. H0, CVaR and EVaR are defined on explicit bounded inputs, without real-world outcome or distributionally robust optimization guarantees.

## First 200: preserved historical baseline

The first 200 connected operators cover graph optimization, inferential statistics, numerical linear algebra, advanced graphs, discrete optimization, finite stochastic decisions, exact bounded number theory, control and computational geometry. The final 84 comprise 12 graph combinatorics, 12 signal processing, 12 descriptive statistics, 12 polynomial algebra, 12 integer arithmetic, 12 structural graphs, and 12 discrete information measures. Their implementations and original deterministic 200-task JSON fixture remain unchanged; see `BATCH_001_200.md` for their specific release gate.

## Operators 201–204 (draft only)

- `GAUSS.MATH.CRT_GENERAL.059` solves bounded congruences with **noncoprime** moduli, detects inconsistent systems and yields a canonical solution modulo their least common multiple. Integer strings prevent false precision.
- `GAUSS.MATH.FINITE_FIELD_MATRIX_INVERSE.060` computes complete square-matrix inverses over verified small prime fields or reports singularity. Dimensions are capped at 12 and primes at 65,521.
- `GAUSS.MATH.INTEGER_POLYNOMIAL_RESULTANT.061` computes the exact Sylvester resultant for integer polynomials of degree 1–6, using BigInt Bareiss elimination. A zero resultant signals a shared complex root.
- `GAUSS.MATH.INTEGER_POLYNOMIAL_DISCRIMINANT.062` computes the exact discriminant and repeated-complex-root signal for bounded integer polynomials of degree 1–6, using a derivative resultant with an exact divisibility check.

`gauss/core/foundation-fixture.mjs` composes the immutable 200-task fixture with four new task definitions, writes a 204-task problem **outside Git**, and binds it to the WALLE report hash. The CRT has 240 small-modulus exhaustive tests; inverses have 250 matrix checks; the polynomial resultant has 80 seeded independent Leibniz test cases, and the discriminant has 240 quadratic/cubic formula cross-checks. WALLE independently checks the specific small-degree polynomial fixture values and rejects forged results even when hashes are recomputed, in addition to replaying the full report. Independent finite tests are not a proof of error-free software, unlimited precision or physical quantum execution; the exact-HEAD connected CI must still pass.

The reference Ising task calls a **classical statevector simulation** in Nexus Quantum and is bound to GAUSS problem and output hashes; this does not use a physical QPU. No math package, new external API, database, queue, secret, service, client change or deployment is needed. Outputs describe only supplied mathematical inputs; they do not establish effectiveness in client businesses.

## Proof entry points

```bash
node --test gauss/tests/*.test.mjs
WALLE_GAUSS_EVIDENCE_ROOT="$(mktemp -d)" bash walle/adapters/gauss.sh
node gauss/core/foundation-fixture.mjs --out /tmp/gauss-204-fixture.json
node scripts/nexus-gauss.mjs /tmp/gauss-204-fixture.json
```

Never merge this draft while the exact final head SHA has pending or failed applicable checks or unresolved production-preview isolation concerns.
