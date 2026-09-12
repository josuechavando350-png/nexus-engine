# WALLE — Controlled Execution, Validation & Certification Engine

WALLE is the internal codename for Nexus' controlled software-assurance platform. Its purpose is to execute software in bounded environments, validate explicit contracts, collect tamper-evident evidence, and emit a reproducible certification verdict.

WALLE is not a deployment system and is not a production mutation path. A workload under test must not gain production authority merely by being connected to WALLE.

## Core principles

1. **Fail closed.** Unknown, malformed, stale, conflicting, unverifiable, or policy-violating states never become PASS.
2. **Evidence before claims.** Missing evidence is reported as `INSUFFICIENT_DATA`; it is never fabricated.
3. **Exact source identity.** Every run binds to an exact source revision and, later, an exact toolchain/environment identity.
4. **Controlled side effects.** Network, filesystem, process, secret, and device access are explicit capabilities, not ambient privileges.
5. **Deterministic certification.** Equal source, contract, evidence, policy, and environment should yield the same certification decision wherever determinism is applicable.
6. **Separation of execution and authority.** A successful test run does not itself authorize deployment, tenant activation, CMS mutation, Ads changes, or any other production action.
7. **Terminal verdicts are immutable.** Once a run reaches a terminal certification state, that run cannot transition back into execution.
8. **No percentage-based escape hatch for critical gates.** One critical integrity or isolation failure blocks certification.

## Initial certification states

WALLE uses these run states:

`PLANNED -> PREPARING -> ISOLATED -> EXECUTING -> VERIFYING -> CERTIFYING -> CERTIFIED`

At any appropriate non-terminal stage, the run may instead terminate as:

- `BLOCKED` — a hard contract, integrity, isolation, or policy gate failed.
- `INSUFFICIENT_DATA` — execution was valid but available evidence cannot support the requested conclusion.
- `CANCELLED` — an authorized operator or kill path stopped the run.

Terminal states cannot transition further.

## Profiles

- `FAST`: short feedback loop for development. Never emits production certification.
- `HARDENED`: stronger verification, fault handling, and security analysis. Still not the maximum certification tier.
- `CERTIFICATION`: the only profile eligible to emit a final `CERTIFIED` verdict once all required controls are implemented.

The foundation intentionally does **not** claim that isolation, signing, SBOM, Firecracker, gVisor, fuzzing, mutation testing, red-team automation, or distributed scheduling already exist. Those are staged capabilities and will be added only with executable tests and evidence.

## Current W0 scope

The first WALLE increment establishes:

- a standalone Rust control-core crate pinned to the same Rust 1.88 toolchain used by Nexus;
- a typed fail-closed state machine;
- strict workload/source identity validation;
- bounded baseline resource plans for FAST/HARDENED/CERTIFICATION profiles;
- a zero-dependency CLI for `version`, `doctor`, `validate-sha`, `transition`, and `plan`;
- locked, formatted, clippy-clean, unit-tested CI verification;
- an explicit threat model and phased architecture roadmap.

W0 does not touch CANO, NexusBotStudio production paths, Avengers tenant activation, Vercel, Cloudflare, CMS data, Google Ads, or client request paths.

## Verification

```bash
bash walle/scripts/verify.sh
```

## First workload

SEO Avengers will be WALLE's first major certification workload, but WALLE itself is deliberately workload-agnostic. The future Avengers adapter must prove whether M001-M2500 were actually executed in a run versus composition-verified/delegated; it may not collapse those two meanings into the same claim.

## Naming

`WALLE` is an internal Nexus codename. If this system is later distributed or marketed publicly, the product name should receive a separate trademark/name review before release.
