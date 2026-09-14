# Walle — Controlled Execution, Validation & Certification Engine

**Walle** is the internal Nexus software-assurance engine. The stable machine identifier remains `WALLE`, but the product/codename is Walle.

Its purpose is to execute software in bounded environments, validate explicit contracts, collect evidence, and emit reproducible verdicts without gaining deployment authority. A workload connected to Walle does not automatically gain permission to deploy, activate a tenant, mutate a CMS, modify Ads, or enter a client request path.

## Core principles

1. **Fail closed.** Unknown, malformed, stale, conflicting, unverifiable, or policy-violating states never become PASS.
2. **Evidence before claims.** Missing evidence is reported as insufficient/unverified; it is never fabricated.
3. **Exact source identity.** Runs bind to an exact source revision and must detect source movement during verification.
4. **Controlled side effects.** Network, filesystem, process, secret, and device access are explicit capabilities, not ambient privileges.
5. **Deterministic certification.** Equal source, contract, evidence, policy, and environment should yield the same decision wherever determinism is applicable.
6. **Separation of execution and authority.** Test success is not deployment authorization.
7. **Terminal verdicts are immutable.** A terminal run cannot transition back into execution.
8. **No percentage escape hatch for critical gates.** One critical integrity or isolation failure blocks certification.

## Run states

`PLANNED -> PREPARING -> ISOLATED -> EXECUTING -> VERIFYING -> CERTIFYING -> CERTIFIED`

Fail-closed terminal exits are `BLOCKED`, `INSUFFICIENT_DATA`, and `CANCELLED`.

## Profiles

- `FAST`: short feedback loop; never the maximum assurance claim.
- `HARDENED`: stronger verification and fault handling.
- `CERTIFICATION`: the only profile eligible for final certification after all required controls are actually implemented and proven.

## Hardware target requested for Walle

The target contract currently records:

- CPU vendor: Intel (`GenuineIntel` at the Linux evidence layer);
- silicon fabrication/process target: **Intel 18A**;
- installed RAM target: **2 TiB** = `2199023255552` bytes;
- virtualization target: Intel VT-x / VMX;
- an additional operator request written as **`Gb 2 TB`**, preserved as a 2 TiB capacity requirement whose hardware component is intentionally `UNRESOLVED` until the operator identifies whether it means storage, GPU memory, or something else.

Walle does not pretend generic Linux host data can prove Intel 18A. `/proc/cpuinfo` can expose vendor/model/VMX but not authoritative fabrication-node provenance. Likewise `/proc/meminfo` reports usable memory, not authoritative installed DIMM capacity. Therefore `host-attest` currently returns a fail-closed non-success verdict until a platform-attestation source can prove those properties.

Commands:

```bash
cargo run --manifest-path walle/core/Cargo.toml --locked -- hardware-contract
cargo run --manifest-path walle/core/Cargo.toml --locked -- host-attest
```

The second command intentionally exits non-zero while the complete target cannot be proven.

## Real SEO Avengers connection

SEO Avengers is no longer only a future placeholder in Walle. The adapter at:

```text
walle/adapters/seo-avengers-2500.sh
```

is connected to the real repository verification chain:

```text
seo-avengers-2500/scripts/verify.sh
  -> seo-avengers-1000/scripts/verify.sh
     -> seo-avengers-800/scripts/verify.sh
        -> seo-avengers-600/scripts/verify.sh
           -> seo-avengers-400/scripts/verify.sh
```

The adapter requires a clean Git tree, optionally binds an expected Git SHA, checks every predecessor reference, runs the real chained verifier under a hard timeout, verifies that HEAD/tree/worktree did not move, hashes verifier/output evidence with SHA-256, and emits `WALLE_AVENGERS_STATUS=VERIFIED_CHAIN` only on success.

It also emits `WALLE_FULL_EXECUTION_CLAIM=false`. This is mandatory because the current chained verifier checks M001-M200 source/catalog parity through `seo-avengers-400`, but it does **not** execute `seo-avengers-200/scripts/verify.sh`. Walle will not mislabel that as 2,500 freshly executed modules.

## Current implemented scope

This branch contains real executable code for:

- a zero-dependency Rust control core pinned to Rust 1.88;
- typed fail-closed state transitions;
- strict workload/source SHA-256 identity validation;
- bounded resource plans;
- the W1 execution-capsule contract with explicit capabilities, canonical manifests, phase receipts, cancellation ownership and structured exit classification;
- W2 host-prerequisite observation for Linux/x86-64, usable KVM, privileged supervision, cgroup v2 controllers and seccomp availability;
- a deterministic W2 Firecracker launch-plan contract that refuses non-ready hosts, binds kernel/rootfs SHA-256 identities, requires a read-only base rootfs and guest seccomp, carries CPU/memory/PID/scratch requirements, emits zero network interfaces for `DENY_ALL`, and refuses secret/device grants it cannot yet enforce;
- a deterministic W2 supervisor contract that exact-binds the execution capsule to the admitted launch plan, rejects stale/tampered plan fields and unsafe host paths, derives cgroup-v2 CPU/memory/PID limits, requires a non-root jail identity, and records mandatory digest verification, atomic materialization, timeout/cancel kill and cgroup-cleanup obligations;
- a W2 supervisor lifecycle orchestrator that requires input verification before side effects, orders run-root/cgroup/materialization before spawn, contains timeout/cancellation and wait failures, force-kills and reaps when graceful termination is insufficient, suppresses release when cleanup fails, and preserves containment state when a possibly live process cannot be killed;
- a dedicated `walle-microvm-plan` command that returns no launch plan when the observed host prerequisites are not ready;
- hardware target/observation logic with tests preventing false Intel 18A/RAM claims;
- a real SEO Avengers chained-verifier adapter with source-stability checks and output/verifier hashes;
- CI that installs exact Python 3.11, Node 24 and Rust 1.88 toolchains and runs the connected verifier.

The W2 launch plan, supervisor plan and lifecycle orchestrator define admission, ordering and failure-containment semantics. They are not proof that Firecracker has started a guest. The lifecycle host is still injected: this branch does not write real cgroup controls, canonicalize or stage image files, verify image bytes, invoke `jailer`/`firecracker`, enforce guest PID/seccomp policy, signal a real VM, or prove cleanup on a KVM host. Those claims remain blocked until a concrete Linux/Firecracker backend and dedicated host tests exist.

The verification script keeps Cargo build output outside the repository so a successful verification must leave the checkout clean.

## Verification

```bash
bash walle/scripts/verify.sh
```

A green run proves the checks that are actually executed by that script. It does not yet prove a successful Firecracker guest launch, runtime microVM isolation, cgroup enforcement, guest PID/seccomp enforcement, image staging integrity, real-process cancellation cleanup, escape resistance, TPM attestation, signed provenance, full M001-M2500 fresh execution, or a bug-free system.

## Still blocked before final certification

Walle must not emit a production-grade final certification claim until, at minimum, the concrete Linux/Firecracker supervisor/jailer backend and runtime capability enforcement, authoritative hardware/environment attestation, durable tamper-evident evidence publication, adversarial isolation/escape testing, and a real no-skip execution path for the currently delegated M001-M200 gap are implemented and tested.

## Naming

Walle is an internal Nexus codename. Public distribution/marketing should receive a separate name/trademark review before release.
