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

The target is **800 implemented layers**. Foundation V1 does **not** claim that 800 layers exist. It registers exactly 21 executable operators, and an unknown/unimplemented layer is rejected fail-closed instead of being represented by a stub. An executable operator is not an entire conceptual layer from the original 20-layer specification; consult `SPEC_ALIGNMENT.md` for the distinction.

## Foundation V1 implemented operators

Foundation V1 contains executable numerical/scientific implementations for:

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

## Connection topology

The Foundation V1 proof path is:

```text
WALLE adapter
  -> NEXUS GAUSS CLI
    -> GAUSS scientific kernel
      -> Nexus Quantum internal Ising/QAOA statevector simulator
    -> hash-bound GAUSS report
  -> independent WALLE fail-closed evidence checks
```

`walle/adapters/gauss.sh` refuses a dirty source tree, syntax-checks the GAUSS/Quantum implementation, runs **all** foundation tests, runs the NEXUS GAUSS CLI on the deterministic 21-operator self-test problem, verifies the report and Quantum receipt, and re-checks the exact Git source identity after execution. The independent WALLE verifier requires the fixture to execute every registered operator **exactly once**, not merely a fixed number of tasks.

The Quantum contribution is real statevector QAOA simulation for an Ising subproblem. It calculates complex amplitudes, expected energy, most-probable state, exact ground-state energy, ground-state probability, approximation gap and statevector normalization error. It explicitly records `hardwareExecution=false` and `quantumAdvantageClaimAllowed=false`. No physical QPU claim is made by this foundation proof.

## No new infrastructure dependency

Foundation V1 adds no external API, new database, queue, network service, secret, or package dependency. Scientific operators use the Node.js standard library only. Existing NEXUS Quantum code remains the Quantum execution plane.

## Evidence boundary

A GAUSS report is not a guarantee that an arbitrary world event will occur. The report proves which mathematical operators ran, with which exact inputs and output hashes. Real-world probability claims require domain-specific data, calibration, prospective validation and WALLE evidence in later layers.

## Run the foundation proof

```bash
WALLE_GAUSS_EVIDENCE_ROOT=/tmp/gauss-proof bash walle/adapters/gauss.sh
```

Or invoke the NEXUS entry point directly:

```bash
node scripts/nexus-gauss.mjs gauss/fixtures/selftest-problem.json
```
