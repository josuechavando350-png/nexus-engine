# GAUSS Advanced V1/V2 — independent, bounded scientific extensions

**Incremental extension.** The audited `gauss/core/registry.mjs` and existing 1,000 operators are untouched. This is a real, separately versioned GAUSS extension, not a claim that all 20 proposed families are implemented.

## Implemented V1 (4 bounded parts of the proposed families)

1. `FORMAL_FINITE_REACHABILITY_V1`: exhaustive invariant AG(!forbidden) and reachability EF(target) of an explicitly supplied graph of ≤64 states, ≤1024 transitions, with shortest BFS witnesses. Does not verify arbitrary code or a live process.
2. `BAYES_BINARY_EXACT_V1`: exact rational Bayesian update for a supplied prior and binary likelihoods. Never treats unmeasured priors as ground truth.
3. `CAUSAL_BINARY_INTERVENTION_V1`: exact Pearl-style `do(X=0/1)` truncated-factorization computation on a **fully specified**, topologically ordered binary Bayesian network with ≤8 nodes and complete probability tables. Reports observational vs interventional risks; does not discover a correct causal DAG from data.
4. `GAME_FINITE_NASH_V1`: exhaustive pure-strategy Nash equilibria for two-player normal-form games with 2–8 strategies per player; for **nondegenerate 2×2** games, computes a strictly interior mixed equilibrium with exact rational probabilities and expected payoffs. It does not compute all mixed equilibria (particularly boundary/degenerate or larger games) or a Monte Carlo tournament.

## Wave 2: three additional scientific implementations

5. `BAYES_BERNOULLI_STREAM_V1` (user item 9): Beta-Bernoulli conjugate posterior, exact rational predictive probabilities and evidence-by-evidence trace. `betaBernoulliUpdates()` additionally consumes a real external `AsyncIterable` and yields asynchronous updates. The GAUSS JSON runner uses the equivalent finite batch input; it does not automatically subscribe to any external data feed. Exchangeability/Bernoulli assumptions are essential.
6. `TDA_PERSISTENT_H0_V1` (item 27): true zero-dimensional persistent homology of a graph filtration with union-find elder rule, finite and essential bars, exact integer birth/death/lifetime and Betti-0 queries; computes H0, **not** higher-dimensional homology or a complete TDA suite.
7. `POMDP_FINITE_HORIZON_V1` (item 64): exact rational Bellman belief-state planning and Bayesian observation updates for a *supplied* two-state/two-action/two-observation POMDP of horizon at most five. Zero-probability observations are omitted, not turned into fictitious evidence. The model-optimal value is not a forecast accuracy percentage.

`gauss/tests/advanced-wave2.test.mjs` tests positive/negative cases and a real `Beta posterior → POMDP` dataflow through the GAUSS executor with existing Quantum receipt linkage. `gauss/core/` is unchanged; the established registry already includes Shannon entropy, KL divergence, discrete CVaR and a finite-horizon MDP, so this wave does not introduce misleading duplicates. This does not assert that all 100 proposals are implemented or that the existing operators fully satisfy every proposed advanced specification.

All probability inputs use JSON strings `"numerator/denominator"` with each nonnegative integer ≤1,000,000,000 and denominator >0. Exact results are reduced fraction strings, not estimated real-world success rates. Input and output SHA-256 are reproducibility identifiers, not cryptographic proofs of algorithm correctness.

`{"$ref":{"taskId":"previous-task","path":["posteriorTrue"]}}` in an input resolves a previously executed task's output, including outputs from optional `gaussTasks`. The runner records the original and resolved input hashes and the SHA-256 of each referenced output; missing, future or failed dependencies block the consumer. Task order is an explicit DAG order, not an implicit guessing mechanism. The optional `gaussTasks` field runs the existing `executeGaussProblem` and its required Quantum contributor, linking the GAUSS report hash and the Quantum receipt hash (classical statevector simulation in the supplied example) in the advanced report. On any task or linked-core failure, top-level status is `BLOCKED`. A SHA-256 digest establishes reproducible data lineage, **not** a proof that an external observation is authentic.

No deployment, external service, credential, network mutation, or client source is touched. This extension is **not certified or merged into main** until a matching GitHub head passes the required checks.

Run from `nexus_engine_runtime`:

```sh
node --test gauss/tests/advanced-*.test.mjs
node scripts/nexus-gauss-advanced.mjs gauss/fixtures/advanced-v1.json
```

## Still to build / validate

Remaining unimplemented families and advanced variants require individual scope, algorithm specification, explicit assumptions and independent tests. Existing GAUSS/Quantum functions must be inventoried before adding any duplicate. Kernel-level signature mutation / fingerprint evasion is **not** part of this offline scientific module. A "99% universal success" certificate is unsupported; model proof is not real-world forecasting calibration.
