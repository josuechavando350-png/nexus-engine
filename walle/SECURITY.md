# WALLE security and trust model

## Security objective

WALLE evaluates potentially faulty or adversarial software without granting that software ambient authority over the host, other workloads, production systems, or certification evidence.

W0 establishes control semantics only. It does not yet provide a production-grade sandbox. No claim of microVM isolation, seccomp confinement, signed provenance, or durable evidence storage is made by this foundation.

## Trusted computing base target

The long-term trusted computing base should be kept intentionally small:

- WALLE control core;
- isolation backend and host kernel/hypervisor components required by that backend;
- evidence publication and verification code;
- immutable certification policy;
- explicitly pinned toolchain/runtime components used to produce the verdict.

A workload adapter is less trusted than the WALLE control core. A workload under test is untrusted.

## Primary threats

WALLE must eventually defend against or detect at least:

- filesystem escape and path traversal;
- symlink/hardlink/TOCTOU attacks;
- unauthorized network access or exfiltration;
- process escape, fork bombs and PID exhaustion;
- CPU, memory, disk and output exhaustion;
- secret discovery or environment-variable leakage;
- device access outside declared capabilities;
- malformed, ambiguous or conflicting evidence;
- receipt/manifest tampering;
- stale generation or replayed evidence;
- workload substitution after source verification;
- toolchain/environment drift;
- partial/crash-corrupted publication;
- nondeterministic divergence hidden by a single successful run;
- policy downgrade or bypass;
- adapter attempts to self-certify;
- cancellation/kill races that release stale results;
- compromised dependency or build artifact evidence.

## Fail-closed rules

1. Unknown state transitions are rejected.
2. Invalid source identities are rejected.
3. Zero or invalid resource ceilings are rejected.
4. Terminal run states are immutable.
5. Later phases must suppress certification evidence if authorization, source identity, environment identity, or evidence identity changes during execution.
6. A workload may report observations; it may not author its own final WALLE verdict.
7. Missing evidence is `INSUFFICIENT_DATA`, not PASS.
8. Integrity or isolation failure is `BLOCKED`, not `INSUFFICIENT_DATA`.
9. Cancellation is terminal for that run. Retry creates a new run identity.
10. Production credentials and mutation authority are outside the default certification capability set.

## Production boundary

WALLE certification must remain separate from deployment authorization. Even a `CERTIFIED` result is evidence that a defined contract passed; it is not permission to deploy, publish, enable a tenant, mutate a CMS, modify Ads, or change production routing.

## W0 limitations

The foundation state machine and contract validator are safety primitives, not a sandbox. Until W2/W3 land and are tested, WALLE must not be used to execute arbitrary untrusted binaries under the claim that the host is isolated from them.
