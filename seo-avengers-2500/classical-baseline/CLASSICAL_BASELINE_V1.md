# WALLE Classical Baseline V1

## Purpose

Classical Baseline V1 is the deterministic classical reference solver for the solver-neutral portfolio model emitted by `WALLE_OPTIMIZATION_PROBLEM_BUILDER_V1`.

Its purpose is to establish a real, reproducible classical baseline **before** any Quantum/Hybrid experiment is allowed to claim an advantage.

The baseline solves the exact bound optimization model it receives. It does not invent SEO opportunities, rewrite upstream evidence, change objective coefficients, publish site changes, or infer causal lift.

## Solver

V1 uses deterministic branch-and-bound over binary decision variables.

The solver:

- consumes only a hash-valid Optimization Problem Builder V1 report;
- preserves the exact upstream objective coefficients;
- enforces budget, editorial, engineering, risk-policy, and maximum-selected constraints;
- enforces dependency implications;
- enforces mutual-exclusion groups;
- uses deterministic search ordering and deterministic tie-breaking;
- uses integer/BigInt arithmetic for objective accumulation;
- emits an explicit global upper bound when the search is unfinished;
- never labels a node-budget-limited result as optimal.

No wall-clock cutoff participates in solver semantics. The reproducibility boundary is an explicit deterministic node budget.

## Search policy

The supported V1 search-order policy is:

`DEPENDENCY_TOPOLOGICAL_OBJECTIVE_DESC_PRIORITY_ASC_ID`

Dependencies are topologically ordered so prerequisites are considered before their dependents. Within the available topological frontier, candidates are ordered by descending bounded objective coefficient, then upstream priority rank, then stable decision identity.

The supported tie-break policy is:

`LOWER_COST_THEN_RISK_THEN_EDITORIAL_THEN_ENGINEERING_THEN_FEWER_SELECTED_THEN_IDENTITY`

Equal-objective portfolios are therefore resolved deterministically without adding a hidden weighted score.

## Bounded exactness

The solver profile declares:

- `maximum_candidates`;
- `node_budget`;
- search-order policy;
- tie-break policy;
- profile identity and provenance.

V1 refuses silent truncation. If the optimization model contains more candidates than the declared baseline limit, the run fails closed rather than solving a hidden subset.

When the branch-and-bound frontier is exhausted, the report is `OPTIMAL` and `optimalityProven=true`.

When the deterministic node budget is exhausted first, the report is `FEASIBLE_NOT_PROVEN_OPTIMAL`; the best incumbent, global upper bound, and absolute gap are preserved explicitly. That result must never be relabeled as optimal.

## Objective semantics

The baseline accepts only the same bounded economic objective emitted by the Optimization Problem Builder:

- `INCREMENTAL_CLIENTS_MILLI`, or
- `INCREMENTAL_REVENUE_MICROS`.

Those coefficients remain bounded scenario values. They are **not** future-outcome forecasts and are not multiplied by empirical rank-transition frequency, calibration error, authority, momentum, competition, or any hidden probability score.

## Provenance

The report binds:

- exact Optimization Problem Builder report SHA-256;
- exact optimization-model SHA-256;
- upstream Decision Engine report SHA-256;
- planning-profile SHA-256;
- baseline-profile SHA-256;
- selected decision-set SHA-256;
- final baseline report SHA-256.

The same model and the same baseline policy therefore produce the same deterministic report identity.

## Tenant boundary

`tenant-baseline.mjs` calls the real tenant Optimization Problem Builder boundary. It does not accept a disconnected tenant-level fabricated optimization report.

After solving, it re-reads both tenant control state and the authorized evidence snapshot. Control-generation or evidence-manifest drift produces `STALE`.

A tenant result is `READY` only when the classical solver proves optimality. A bounded but unfinished solve remains `INSUFFICIENT_DATA` with the report preserved for audit.

The production layer adds no provider-network client, Google scraper, browser/process execution, remote solver, publishing path, CMS/site mutation, external-link creation, or tenant-control mutation authority.

## Quantum comparison boundary

Classical Baseline V1 is the reference competitor for the next Quantum/Hybrid experiment.

A Quantum/Hybrid method must receive the **same bound optimization problem** and must be compared against this classical baseline under predeclared metrics. Quantum receives no special scoring treatment and no advantage may be claimed merely because a quantum backend was used.

If the classical method is better, classical wins.

If a Quantum/Hybrid method is better, the evidence must show exactly where and under which predeclared metric it is better.

## Explicit non-claims

Classical Baseline V1 is **not**:

- a rank forecast or rank guarantee;
- proof of causal SEO lift;
- a future traffic, lead, client, or revenue guarantee;
- a hidden probability-adjusted score;
- evidence of quantum advantage;
- an autonomous action engine.

The baseline exists so the subsequent solver tournament has a real classical standard to beat rather than a weak or fabricated comparator.
