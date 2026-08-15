# Codex V9 Task 01 — Measurement Harness Core

Implement the first V9 capability block on top of the current `v9-foundation` branch.

## Goal

Create a framework-neutral, deterministic Measurement Harness core that models workload definitions, environment descriptors, run identities and measured evidence envelopes without binding the core to Playwright, WebDriver, Chrome, WebGPU APIs, Node process globals, or any vendor SDK.

## Required location

Use a new package/module boundary under `packages/measurement` (preferred) or another clearly isolated V9 package if repository conventions require it. Do not put browser/vendor adapters into the core.

## Required contracts

- `MeasurementScope` compatible with tenant/brand isolation rules.
- immutable `WorkloadDefinition` with canonical workload ID, version, metric declarations and deterministic parameters;
- immutable `EnvironmentDescriptor` with explicit OS/runtime/device/browser/GPU fields as data only;
- `MeasurementRun` / `RunIdentity` including source commit SHA, workload version and environment identity;
- `RawMeasurementSample` with metric name, finite numeric value, explicit unit and sample index;
- `MeasurementEvidence` that distinguishes `MEASURED`, `UNSUPPORTED`, `FAILED`, `CANCELLED`;
- deterministic identity/canonicalization independent of object insertion order and locale;
- explicit rejection of NaN/Infinity, duplicate sample indexes, unit mismatch, scope mismatch and malformed IDs;
- missing evidence must never map to PASS.

## Architecture constraints

- No imports from React, Next.js, Three.js, GSAP, Playwright, Puppeteer, Selenium/WebDriver, browser globals, WebGPU/WebGL globals, Rust/Industrial packages, or external telemetry vendors.
- Keep adapters replaceable behind ports.
- Do not claim BENCHMARKED, OPERATIONALLY_EVIDENCED or PRODUCTION_PROVEN.
- Preserve V8 behavior and existing tests.

## Tests

Add strong Vitest coverage for:

- deterministic canonical identity;
- order invariance;
- tenant/brand isolation;
- finite-number validation;
- duplicate sample rejection;
- unit mismatch rejection;
- explicit unsupported/failed/cancelled states;
- source commit/workload/environment lineage;
- no browser/vendor dependency leakage.

## Definition of done

- lint, typecheck, tests, build and all V3→V9 gates pass;
- public API remains vendor-neutral;
- no unsupported maturity claim is introduced;
- implementation is small enough for a focused PR.

Do not merge to `main`. Commit only to a dedicated branch based on the latest V9 foundation after it is available, and report the exact changed files plus any design tradeoff discovered.
