# GAUSS — Scientific Decision Kernel

GAUSS is the NEXUS-owned scientific decision kernel. Foundation V1 begins the requested 800-layer architecture as eight scientific domains with a target of 100 real layers per domain:

- mathematics;
- physics and complex systems;
- computer science;
- statistics and probability;
- decision theory;
- causal and experimental inference;
- control and dynamics;
- information theory.

The target is **800 implemented layers**. Foundation V1 began with 21 executable operators; discrete CVaR became operator 22, and the bounded discrete EVaR extension proposes operator **23**. Unknown/unimplemented layers are rejected fail-closed instead of being represented by stubs. One executable operator is not an entire conceptual layer from the original 20-layer specification; consult `SPEC_ALIGNMENT.md` for the distinction.

## Implemented operators

The GAUSS kernel contains executable numerical/scientific implementations for:

- empirical one-dimensional Wasserstein-2 distance;
- exact Pareto frontier selection;
- weighted graph Laplacian construction;
- zero-dimensional persistent homology (H0) of a bounded undirected weighted graph filtration;
- Takens time-delay embedding;
- Ising Hamiltonian energy;
- exact bounded Ising ground-state enumeration;
- Wilson binomial confidence intervals;
- Brier probability calibration score;
- seeded percentile bootstrap mean intervals;
- expected utility;
- minimax regret;
- weighted discrete CVaR for explicitly supplied loss probabilities;
- **weighted discrete EVaR** via a bounded KL-constrained exponential tilt;
- difference-in-differences;
- normalized inverse-propensity weighted ATE (Hájek-style);
- finite-horizon scalar LQR;
- seeded Euler-Maruyama SDE integration;
- Shannon entropy;
- discrete mutual information;
- Rényi divergence;
- exact branch-and-bound binary knapsack;
- finite-trace verification of `G(request -> F(certification))`.

The H0 implementation explicitly counts essential (infinite) intervals, finite intervals and cycle edges without inserting a non-JSON `Infinity` value into evidence. Its unit tests compare barcode death multiplicities to independent breadth-first connectivity across 150 seeded weighted graphs. It does not implement higher-dimensional homology, zigzag persistence or prove that a market forecast improves.

The CVaR operator `GAUSS.DECISION.CVAR_DISCRETE.003` accepts 1–10,000 scenarios with explicit finite losses and nonnegative probabilities summing to one, and a confidence in `[0, 0.999999]`. Larger losses are worse. It returns the loss quantile (VaR), mean of the worst `1-confidence` probability mass (CVaR), and expected loss. An independent convex-loss formulation is checked across 180 seeded distributions; malformed distributions fail closed.

The EVaR operator `GAUSS.DECISION.EVAR_DISCRETE.004` accepts **1–4,096 explicitly supplied scenarios**, finite losses in `[-1e9, 1e9]`, nonnegative probabilities summing to one within `1e-12` round-off, and confidence in `[0, 0.999999]`. Zero-probability outcomes are ignored. It evaluates the finite-support entropic risk definition `inf_{t>0} (log E[exp(t loss)] - log(1-confidence))/t` using stable exponential tilting and a monotone KL-divergence root. It returns expected loss, worst supported loss, entropy budget, realized tilted KL, EVaR and whether the solution is a mean, constant, worst-loss boundary or interior tilt. At confidence zero EVaR is the supplied expected loss; when the worst loss alone has enough probability mass, EVaR is that worst loss. Unbracketed or unconverged numerical problems fail closed. Its tests independently check a two-point KL-ball oracle and a separate Chernoff minimizer across 180 seeded distributions, compare the result against CVaR, and reject malformed distributions.

**Neither CVaR nor EVaR is calibrated to an external population without evidence.** The EVaR extension does not implement Wasserstein distributionally robust optimization, a valid empirical loss distribution for an actual client, guaranteed improvement, or physical quantum advantage. The 800 count is a target, not a completion claim.

## Connection topology

The connected proof path is:

```text
WALLE adapter
  -> NEXUS GAUSS CLI
    -> GAUSS scientific kernel
      -> Nexus Quantum internal Ising/QAOA statevector simulator
    -> hash-bound GAUSS report
  -> independent WALLE fail-closed evidence checks
```

`walle/adapters/gauss.sh` refuses a dirty source tree, syntax-checks GAUSS/Quantum, runs **all** foundation tests, runs the NEXUS GAUSS CLI on the deterministic 23-operator self-test problem, verifies the report and Quantum receipt, and checks the Git source identity after execution. WALLE requires every registered operator **exactly once**, not just a fixed task count; it must reject falsified EVaR or CVaR outputs even if their output and report hashes are recomputed.

The Quantum contribution is a real statevector QAOA simulation for an Ising subproblem. It calculates complex amplitudes, expected energy, most-probable state, exact ground-state energy, ground-state probability, approximation gap and statevector normalization error. It explicitly records `hardwareExecution=false` and `quantumAdvantageClaimAllowed=false`. No physical QPU claim is made by this foundation proof.

## No new infrastructure dependency

The Foundation, CVaR and EVaR extensions add no external API, new database, queue, network service, secret or package dependency. Scientific operators use the Node.js standard library only. Existing NEXUS Quantum code remains the Quantum execution plane.

## Evidence boundary

A GAUSS report is not a guarantee that an arbitrary world event will occur. It proves which mathematical operators ran, with which exact inputs and output hashes. Real-world probability claims require domain-specific data, calibration, prospective validation and WALLE evidence in later layers.

## Run the foundation proof

```bash
WALLE_GAUSS_EVIDENCE_ROOT=/tmp/gauss-proof bash walle/adapters/gauss.sh
```

Or invoke the NEXUS entry point directly:

```bash
node scripts/nexus-gauss.mjs gauss/fixtures/selftest-problem.json
```
