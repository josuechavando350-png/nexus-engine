# NEXUS V3 — Failure Modes

How each component behaves when something breaks. The rule throughout: fail
closed on anything that could move matter, degrade gracefully on anything that
only affects observation.

## 1. Component behaviour

| Component | Failure | Behaviour | Data loss |
|---|---|---|---|
| Broker unreachable | network or outage | ingest stops fetching, gateway spools to disk, health reports not-ready but still live | none until spool cap |
| Spool full | prolonged outage | oldest telemetry dropped, drop counted and exported | bounded, visible |
| Graph unreachable | backend down | mutations retry with backoff, circuit opens, proposals stop | none; mutations replayed |
| Graph slow | contention | backpressure to ingest, then to broker | none |
| Malformed event | bad producer | rejected at schema validation, dead-lettered | none; inspectable |
| Integrity hash mismatch | corruption or tampering | rejected, dead-lettered, audited | none |
| Duplicate delivery | at-least-once | dropped by dedup index, counted | none |
| Duplicate outside window | window too small | reprocessed; graph effect idempotent so no second effect | none |
| Sequence gap | loss or reorder | `Gap { missing }` recorded and exported | telemetry lost upstream |
| Ambiguous resolution | two equal candidates | refuses to commit, flagged for review | none |
| Policy denies | prohibited or unauthorised | task not dispatched, denial audited with code | none |
| Simulation fails | collision predicted | task denied by hard invariant | none |
| Approval expires | operator did not respond | task not dispatched | none |
| Signing key unavailable | secret manager down | task not signed, not dispatched, alert | none |
| WASM fuel exhausted | runaway module | terminated, failure audited, not blindly retried | none |
| WASM module hash mismatch | tampered module | refused before execution | none |
| Edge device unreachable | radio or power | task expires unexecuted, expiry audited | none |
| Process crash | any | restart replays from last committed offset | none; effects idempotent |
| Audit sink unavailable | storage down | in-memory chain continues; **durability is lost until restored** | audit records at risk |

## 2. Deliberate design choices

**Bounded loss over unbounded growth.** Every buffer has a cap. Hitting a cap
drops data and counts the drop. The alternative — growing until the process is
killed — loses everything instead of some, at the least convenient moment.

**Fail closed on action, degrade open on observation.** A policy engine that
cannot complete an evaluation denies. A metrics exporter that cannot reach its
collector keeps serving traffic.

**Retry only what can succeed.** `NexusError::is_retryable` returns true only
for adapter and exhaustion errors. Schema, integrity and policy failures are
permanent and go straight to the dead-letter topic.

**Liveness and readiness are separate.** A broker outage makes a service
not-ready — stop routing work to it — while keeping it live, so it is not
restarted into a crash loop while the broker recovers.

## 3. Recovery

- **Restart:** replay from the last committed offset. Idempotency keys make
  reprocessing harmless.
- **Dead-letter drain:** messages carry their rejection reason and can be
  replayed after the producer is fixed.
- **Bad merge:** merges are recorded as `SAME_AS` edges rather than
  destructive, so an incorrect resolution can be unwound.
- **Key compromise:** revoke the signer; in-flight tasks fail
  `no_unknown_signer` at the device.

## 4. Fault injection

`nexus-sim` supports injecting broker unavailability, graph latency and
failure, malformed events, duplicate storms, sequence gaps, expired tasks,
signature failures and sandbox exhaustion, so the table above is exercised
rather than asserted.

**Status: the fault-injection tests are written and have not been executed** —
no Rust toolchain was available in the build environment. See
`NEXUS_V3_VALIDATION.txt`.
