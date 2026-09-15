# WALLE Optimization Problem Builder V1

## Purpose

Optimization Problem Builder V1 is the formulation boundary between the certified evidence-gated Decision Engine and any future solver tournament.

It does **not** solve the portfolio, predict an SEO outcome, or execute a site change. It converts only `PROMOTE_TO_OPTIMIZATION` decisions from a hash-valid `WALLE_DECISION_ENGINE_V1` report into a deterministic solver-neutral binary portfolio model.

## Required inputs

The builder requires:

- a hash-valid Decision Engine V1 report with at least one promoted decision;
- an explicit planning profile whose planning items cover every promoted decision exactly once;
- explicit total budget, editorial capacity, engineering capacity, risk-capacity points, and maximum-selected limits;
- optional dependency edges and mutual-exclusion groups.

Planning estimates are never invented by the builder. Every candidate carries an explicit estimate basis: `OBSERVED`, `CONTRACTED`, or `ESTIMATED`.

## Objective semantics

The objective coefficient for each binary candidate is the bounded scenario value already emitted by the Decision Engine's upstream economic objective:

- `INCREMENTAL_CLIENTS_MILLI`, or
- `INCREMENTAL_REVENUE_MICROS`.

The builder preserves that value exactly. It does not multiply it by empirical rank-transition frequency, calibration error, feasibility, authority, momentum, competition, or any hidden weight.

Empirical transition frequency remains evidence context only. It is not converted into expected value or a success probability.

## Variables

Each promoted Decision Engine row becomes one binary variable identified by its exact `decisionId`.

The variable preserves:

- query and page identity;
- Pareto rank/layer/frontier context;
- selected rank target and feasibility band;
- bounded economic scenario coefficient;
- explicit resource coefficients and estimate basis;
- empirical transition counts/frequency as non-objective evidence context.

Held decisions are excluded. A planning profile cannot add held or unknown decisions.

## Constraints

V1 emits explicit linear portfolio constraints:

- total cost micros <= `budget_micros`;
- total editorial units <= `editorial_capacity_units`;
- total engineering units <= `engineering_capacity_units`;
- total risk policy units <= `risk_capacity_units`;
- selected variable count <= `maximum_selected`;
- dependency implication `x(decision) <= x(required)` for every declared dependency;
- at most one selected variable per mutual-exclusion group.

Risk units are operator-defined policy-capacity points. They are not probabilities.

Dependency references must resolve only to promoted candidates. Self-dependencies, duplicate edges, and dependency cycles fail closed in V1. Mutual-exclusion groups must reference at least two unique promoted candidates.

## Determinism and provenance

All output-affecting values use strict schemas, bounded safe integers, canonical JSON, NFC normalization, and SHA-256 identities.

The report binds:

- exact Decision Engine report SHA-256;
- normalized planning profile SHA-256;
- complete variables/objective/constraints model SHA-256;
- final report SHA-256.

Equivalent planning-item, dependency-edge, and mutex-member ordering canonicalizes to the same planning/model/report identity.

## Tenant boundary

`tenant-problem.mjs` calls the real tenant Decision Engine boundary. It does not accept a disconnected fabricated upstream report at the tenant layer.

After formulation it re-reads both tenant control state and the authorized evidence snapshot. Control-generation or evidence-manifest drift produces `STALE`; invalid formulation input produces `BLOCKED`.

The layer has no provider-network client, Google scraper, browser/process execution, solver execution, publishing path, CMS/site mutation, external-link creation, or tenant-control mutation authority.

## Explicit non-claims

Optimization Problem Builder V1 is **not**:

- a solver result;
- a rank forecast or rank guarantee;
- a causal SEO-lift estimate;
- a future traffic, lead, client, or revenue guarantee;
- a probability-adjusted expected-value model;
- an autonomous action engine.

The next layer must solve the exact solver-neutral formulation and benchmark the result. A future Quantum/Hybrid candidate must compete against a certified classical baseline on the same bound problem rather than receiving special treatment.
