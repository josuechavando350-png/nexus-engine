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

SEO Avengers is connected to Walle through:

```text
walle/adapters/seo-avengers-2500.sh
```

The adapter preserves the existing verifier chain:

```text
seo-avengers-2500/scripts/verify.sh
  -> seo-avengers-1000/scripts/verify.sh
     -> seo-avengers-800/scripts/verify.sh
        -> seo-avengers-600/scripts/verify.sh
           -> seo-avengers-400/scripts/verify.sh
```

It also executes the original `seo-avengers-200/scripts/verify.sh` directly. Both verifier paths are fail-closed: a timeout, non-zero exit, or detected `SKIP` prevents a full-execution claim.

Verifier green is not treated as module execution. After the verifiers pass, `walle/scripts/seo_avengers_2500_proof.py` collects fresh controlled execution evidence through the runtimes that already exist:

- **M001-M200:** `seo-avengers-200/scripts/local-mirror-e2e.sh` starts the local Python/Go stack, activates a synthetic `walle-proof-probe` only inside its temporary mirror, dispatches exactly 200 asynchronous contract jobs, requires `submitted=200`, `complete=200`, `failed=0`, and exports each completed job receipt through the existing `seo.job.get` RPC. Each receipt binds the exact Git source revision supplied by Walle.
- **M201-M400:** the existing `seo-avengers-400/runtime/service.py` execution path runs its complete controlled fixture and must return exactly M201-M400.
- **M401-M600:** the existing `seo-avengers-600/runtime/service.py` execution path must return exactly M401-M600.
- **M601-M800:** the existing `seo-avengers-800/runtime/service.py` execution path must return exactly M601-M800.
- **M801-M1000:** the existing `seo-avengers-1000/runtime/service.py` execution path must return exactly M801-M1000.
- **M1001-M2500:** the existing `seo-avengers-2500/sidecar/execute_suite.py` path calls the real 1,500-module runner and must return exactly M1001-M2500 plus its execution and terminal evidence hashes.

These are controlled test fixtures, not production tenant executions. Walle does not activate Cano Penal, SOMA, Nexus Bot Studio, or any external tenant to produce this proof.

Evidence is written outside the source tree. Walle re-checks Git HEAD, tree identity, and worktree cleanliness before and after execution. The evidence packet contains verifier logs, per-range runtime output, 2,500 normalized module records, per-receipt SHA-256 bindings, exact source revision/tree bindings, a proof summary, and a SHA-256 manifest. CI uploads that packet as a GitHub Actions artifact.

`WALLE_FULL_EXECUTION_CLAIM=true` is never hardcoded. It is derived only when all of the following remain true at the same time:

- exactly 2,500 expected module records exist;
- all 2,500 IDs are unique and exactly M1 through M2500;
- no required module is missing or duplicated;
- every required module is `EXECUTED` rather than `FAILED`, `BLOCKED`, or `NOT_TESTED`;
- no runtime or verifier reports a skip;
- every executed module has a valid evidence hash and a SHA-256-bound raw receipt;
- raw receipt containers have the exact expected cardinality and ranges;
- M001-M200 receipts bind the exact source revision;
- the M1001-M2500 sidecar range and terminal hash are internally consistent;
- both verifier gates are PASS and their copied logs match their recorded SHA-256 hashes;
- source HEAD/tree/worktree remain unchanged.

Any violation leaves `WALLE_FULL_EXECUTION_CLAIM=false` and the adapter exits non-zero.

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
- a real SEO Avengers verifier + execution-proof adapter with source-stability checks and module-level receipts;
- negative proof-gate tests covering missing/duplicate modules, corrupt evidence, wrong hashes/source binding, timeout, runtime error, SKIP, incomplete evidence, cardinality drift, module failure and `NOT_TESTED`;
- CI with pinned Python 3.12 for the original Avengers 200 stack, Python 3.11 for Walle, Node 24, Rust 1.88, and uploaded external evidence artifacts.

The W2 launch plan, supervisor plan and lifecycle orchestrator define admission, ordering and failure-containment semantics. They are not proof that Firecracker has started a guest. The lifecycle host is still injected: this branch does not write real cgroup controls, canonicalize or stage image files, verify image bytes, invoke `jailer`/`firecracker`, enforce guest PID/seccomp policy, signal a real VM, or prove cleanup on a KVM host. Those claims remain blocked until a concrete Linux/Firecracker backend and dedicated host tests exist.

The verification path keeps Cargo output and SEO Avengers evidence outside the repository so a successful run must leave the checkout clean.

## Verification

```bash
bash walle/scripts/verify.sh
```

For an explicit evidence destination outside the checkout:

```bash
WALLE_AVENGERS_EVIDENCE_ROOT=/absolute/path/outside/nexus-engine \
  bash walle/scripts/verify.sh
```

A run may claim complete SEO Avengers execution only if its output contains `WALLE_FULL_EXECUTION_CLAIM=true`, `WALLE_MODULE_EXECUTED=2500`, zero `FAILED`, zero `BLOCKED`, zero `NOT_TESTED`, and the corresponding proof/manifest hashes. A verifier-only green result is not equivalent to that claim.

This workload proof is separate from Walle's final `CERTIFIED` state. It does not prove a successful Firecracker guest launch, runtime microVM isolation, cgroup enforcement, guest PID/seccomp enforcement, image staging integrity, real-process cancellation cleanup, escape resistance, TPM attestation, authoritative hardware provenance, or a bug-free system.

## Still blocked before final certification

Walle must not emit a production-grade final certification claim until, at minimum, the concrete Linux/Firecracker supervisor/jailer backend and runtime capability enforcement, authoritative hardware/environment attestation, durable tamper-evident evidence publication beyond CI artifacts, and adversarial isolation/escape testing are implemented and proven on the required host class.

## Naming

Walle is an internal Nexus codename. Public distribution/marketing should receive a separate name/trademark review before release.
