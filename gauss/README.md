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

The target is **800 implemented layers**. Foundation V1 does **not** claim that 800 layers exist. It registers exactly 20 executable operators, and an unknown/unimplemented layer is rejected fail-closed instead of being represented by a stub.

## Foundation V1 implemented operators

Foundation V1 contains real deterministic implementations for:

- empirical one-dimensional Wasserstein-2 distance;
- exact Pareto frontier selection;
- weighted graph Laplacian construction;
- Takens time-delay embedding;
- Ising Hamiltonian energy;
- exact bounded Ising ground-state enumeration;
- Wilson binomial confidence intervals;
- Brier probability calibration score;
- seeded percentile bootstrap mean intervals;
- expected utility;
- minimax regret;
- difference-in-differences;
- inverse-propensity weighted ATE;
- finite-horizon scalar LQR;
- seeded Euler-Maruyama SDE integration;
- Shannon entropy;
- discrete mutual information;
- Renyi divergence;
- exact branch-and-bound binary knapsack;
- finite-trace verification of `G(request -> F(certification))`.

These are executable numerical/scientific operators, not names reserved for future code.

## Connection topology

The Foundation V1 proof path is:

```text
WALLE adapter
  -> NEXUS GAUSS CLI
    -> GAUSS scientific kernel
      -> Nexus Quantum internal Ising/QAOA statevector simulator
    -> hash-bound GAUSS report
  -> WALLE fail-closed evidence checks
```

`walle/adapters/gauss.sh` refuses a dirty source tree, syntax-checks the GAUSS/Quantum implementation, runs the foundation tests, runs the NEXUS GAUSS CLI on the deterministic 20-layer self-test problem, verifies the report and Quantum receipt, and re-checks the exact Git source identity after execution.

The Quantum contribution is real statevector QAOA simulation for an Ising subproblem. It calculates complex amplitudes, expected energy, most-probable state, exact ground-state energy, ground-state probability, approximation gap and statevector normalization error. It explicitly records `hardwareExecution=false` and `quantumAdvantageClaimAllowed=false`. No physical QPU claim is made by this foundation proof.

## No new infrastructure dependency

Foundation V1 adds:

- no external API;
- no new database;
- no queue;
- no network service;
- no new secret;
- no package dependency.

The scientific operators use the Node.js standard library only. Existing NEXUS Quantum code remains the only Quantum execution plane.

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
