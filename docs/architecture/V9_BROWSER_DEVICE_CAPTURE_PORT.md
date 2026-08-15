# V9 Browser / Device Capture Port

## Purpose

Define a replaceable boundary for collecting visual and runtime evidence from browsers/devices without coupling the V9 core to Playwright, WebDriver, Chrome, Safari, Chromium, WebKit, a cloud device farm, or any single vendor.

## Core contract

The core owns only vendor-neutral contracts. Adapters own browser/device-specific behavior.

Required request fields:

- scoped identity: `tenantId`, `brandId`;
- measurement run identity;
- workload identity and version;
- environment descriptor identity;
- target descriptor (browser engine/family, version, OS, device class, viewport, DPR);
- capture intent (visual, performance, interaction, resource, trace);
- deterministic artifact naming inputs;
- timeout and evidence-completeness policy.

Required result semantics:

- `CAPTURED`, `UNSUPPORTED`, `FAILED`, `TIMED_OUT`, `PARTIAL` are explicit and never collapsed into PASS;
- every artifact is linked to the run, workload, environment, target and scope;
- raw artifact digests are immutable evidence identity inputs;
- missing expected artifacts are explicit completeness failures;
- adapter/vendor metadata is recorded but does not become core identity authority.

## Isolation and safety

- cross-tenant and cross-brand evidence mixing is forbidden;
- a capture adapter may not read or emit evidence for a different scope than the request;
- secrets/cookies/auth material must be references/leases supplied through adapter configuration, never embedded in evidence envelopes;
- browser/device adapters must not gain authority to change workload definitions or maturity claims.

## Replaceability

The port must support multiple adapters, including local browser automation, remote browser grids and real-device farms, without changing the core contracts. Adapter selection is configuration/policy, not hard-coded vendor logic.

## Determinism

Deterministic identity applies to workload/environment/target/capture-plan descriptors and artifact manifests. Actual measured values are observations and are never fabricated to satisfy determinism.

## Acceptance tests for the implementation block

1. identical normalized request descriptors produce the same capture-plan identity;
2. scope mismatch is rejected;
3. unsupported targets are explicit and are not PASS;
4. missing expected artifacts produce incomplete evidence;
5. duplicate artifact identities with conflicting digests are rejected;
6. vendor metadata changes do not rewrite workload/run identity;
7. no core package imports browser globals or a specific browser automation vendor.

## Evidence claim boundary

Implementing this port does not prove that a browser/device capture occurred. `BENCHMARKED`, `OPERATIONALLY_EVIDENCED` and `PRODUCTION_PROVEN` remain forbidden unless stored measured artifacts exist and pass V9 evidence gates.
