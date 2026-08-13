# NEXUS V3 — Threat Model

Scope: the Industrial Agentic Runtime. The V2 Experience plane has its own
security posture and shares no code with this one.

## 1. Assets

| Asset | Why it matters |
|---|---|
| Signing keys | Forge an `EdgeTask` and you command a robot |
| Trusted signer set | Add an entry and you are trusted |
| The ontology | Corrupt it and every downstream decision is wrong |
| The audit trail | Destroy it and nothing is reconstructable |
| Policy invariants | Weaken them and the prohibitions stop applying |
| Telemetry in transit | Process data useful to an attacker |
| Edge devices | The only things that move matter |

## 2. Adversaries

1. **Remote unauthenticated attacker** on the analytics network.
2. **Compromised sensor or camera** inside the OT zone.
3. **Malicious or buggy WASM module** supplied to the edge runtime.
4. **Insider with operator credentials** but not approval authority.
5. **Attacker with code execution on the gateway host.**
6. **Supply-chain attacker** in a dependency.

## 3. Threats and mitigations

### T1 — Forged telemetry
*Adversary 2.* Fabricated readings drive a false incident and a real robot
task.
**Mitigations:** envelope signature; `integrity_hash` over canonical bytes;
`SequenceTracker` gap and replay detection; entity resolution refuses to guess
on ambiguity; simulation and policy sit between an incident and any action.
**Residual:** a compromised sensor with a valid key can lie within plausible
bounds. Cross-source correlation reduces but does not eliminate this.

### T2 — Replayed command
*Adversaries 1, 5.* Re-sending a previously valid task.
**Mitigations:** `expires_at` on every task; nonce window; hard invariants
`no_expired_command` and `no_replayed_nonce`.
**Residual:** the nonce window is bounded; a replay after eviction and before
expiry is possible. The expiry window is therefore configured shorter than the
nonce window.

### T3 — Forged or escalated command
*Adversaries 1, 4.* Issuing a task the issuer is not entitled to.
**Mitigations:** Ed25519 signatures; trusted signer set; `no_unknown_signer`;
capability intersection with the device's declared capabilities;
`HumanApprovalGate` for high impact; approver role check; separate identity
for the `CONTROLLED_EDGE` channel.
**Residual:** a stolen signing key is fully effective until revoked. Key
rotation and revocation are deployment responsibilities.

### T4 — Weaponization or human targeting
*Any adversary, including a careless internal change.*
**Mitigations:** compiled hard invariants that cannot be configured off; 36
prohibited terms matched across action name, zone, capabilities and free-text
annotations; closed `DetectionClass` with no person-identification class;
closed `EntityKind` with no target kind; CI gate that fails if any of these is
weakened.
**Residual:** a determined maintainer can edit the source. The control is that
doing so is a visible, reviewable diff that breaks a named gate.

### T5 — Sandbox escape
*Adversary 3.*
**Mitigations:** no filesystem, no network, fuel budget, memory cap, timeout,
host-function allowlist, capability tokens, module hash validation against a
signed manifest; `#![forbid(unsafe_code)]` in every crate; CI gate rejecting
`std::process::Command`, dynamic loading and raw-pointer escapes in the edge
path.
**Residual:** a vulnerability in the WASM engine itself. Mitigated by pinning
and by `cargo audit` in CI.

### T6 — Graph poisoning
*Adversaries 2, 4.* Bad merges corrupt the system of record.
**Mitigations:** deterministic resolution with explainable scores; ambiguity
refuses to commit; merges are recorded as `SAME_AS` rather than destructive,
so they can be unwound; conflicts retain both values; full provenance on every
fact; `graphd` is the only writer.
**Residual:** sustained plausible poisoning below the review threshold.

### T7 — Audit tampering
*Adversary 5.*
**Mitigations:** hash-chained records; editing or removing an interior record
breaks verification — asserted by test.
**Residual:** an attacker who can rewrite the whole store can recompute the
chain. Real tamper-evidence requires an external anchor: a WORM volume, an
append-only broker topic, or a signed periodic digest shipped off-box.
`AuditSink` exists so anchoring is a deployment choice rather than a rewrite.
**This is an accepted, documented residual risk, not a solved problem.**

### T8 — Reverse channel through the diode
*Adversaries 1, 5.*
**Mitigations:** no listener on the OT side, no command topic subscription, no
inbound connection accepted, topic allowlist, classification ceiling failing
closed, no bidirectional RPC on the path.
**Residual:** software is not a physical diode. See
`../architecture/V3_ONEWAY_SECURITY.md`.

### T9 — Supply chain
*Adversary 6.*
**Mitigations:** the default feature set has **zero external dependencies**,
so the default artifact's third-party attack surface is empty. Optional
adapters are pinned; `cargo deny` restricts licences, bans duplicate and
wildcard versions and unknown registries; `cargo audit` runs in CI; SBOM
generated per build.
**Residual:** enabling `kafka`, `neo4j`, `wasmtime` or `ed25519` introduces a
transitive tree that must be monitored.

### T10 — Denial of service
*Adversaries 1, 2.*
**Mitigations:** bounded queues, backpressure to the broker, circuit breakers,
bulkheads, bounded dedup and nonce windows, capped spool, JSON depth limit,
strict parser rejecting hostile input early.
**Residual:** a flood from an authenticated source degrades throughput. Bounded
loss is preferred over unbounded memory growth and is counted.

## 4. Explicit non-goals

- Physical isolation.
- Protection against a compromised host running the runtime.
- Protection against a maintainer who edits the invariants.
- Anti-tamper for edge device firmware.
- Traffic analysis resistance.

## 5. Supply-chain policy

No advisory is ignored by default. `deny.toml` carries an empty `ignore` list;
an advisory that cannot be immediately fixed gets a dated, justified entry
here and in the file, never a silent blanket exemption. Licences are restricted
to permissive ones so the runtime can ship to customer sites without changing
the product's licensing position.
