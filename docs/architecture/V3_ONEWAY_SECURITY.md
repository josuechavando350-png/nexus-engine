# NEXUS V3 — One-way Security

## 1. The claim this document refuses to make

**A software gateway is not a data diode.**

A physical data diode is an optical or electrical component with no return
path. `nexus-oneway` runs on general-purpose hardware over a bidirectional
network stack. It reduces a bidirectional substrate to a one-directional
protocol, and it can be defeated by an attacker with code execution on the
gateway host.

Nothing in this repository states that software physically guarantees or
enforces unidirectionality, and a CI gate fails the build if such a phrase
appears in a document or a source comment.

What the software does provide: no listening socket on the protected side, no
command topic subscription, no inbound control connection accepted, egress
only, signed messages, validation on receipt, append-only audit. Where real
isolation is required, this runs *behind* a hardware diode and complements it.

## 2. Profile A — OBSERVATION_DIODE

```text
Protected OT zone
    |
    | telemetry only
    v
Gateway sender  (egress only, no listener)
    |
    v
Analytics zone  (validates signatures, appends to audit)
```

Rules, enforced in code:

- The OT side opens **no listener**.
- The OT side subscribes to **no command topic**.
- The OT side accepts **no inbound control connection**.
- Egress only, restricted to `OT_EGRESS_ALLOWLIST`:
  `nexus.telemetry.raw`, `nexus.detections`, `nexus.audit`.
- Messages are signed; the receiving side validates before accepting.
- Audit is append-only and hash-chained.
- No bidirectional RPC exists on this path.
- Classification ceiling: anything above the configured ceiling is refused,
  failing closed.

**This profile cannot control the device.** There is no code path from the
analytics zone back to an actuator through it. That is the whole point, and
it is asserted by test rather than promised in prose.

Buffering: an outage spools to disk within a byte cap. Full means oldest
telemetry is dropped and the drop is counted — bounded loss that is visible,
rather than unbounded growth that takes the gateway down.

## 3. Profile B — CONTROLLED_EDGE

Legitimate control needs a channel. Pretending otherwise leads to control
being smuggled through the observation path, which is worse than admitting it
exists.

- A **separate channel**, not the diode path.
- A **separate identity**: different key material, different signer id.
- Policy engine evaluation on every command.
- mTLS between orchestrator and edge.
- Signed, typed, expiring commands with anti-replay.
- `HumanApprovalGate` for anything high impact.
- Its own audit stream.

**It is not the diode and is never described as one.** The two profiles are
distinct types with distinct configuration; a deployment chooses one per link,
and the observation profile has no command capability to enable.

## 4. Resolving the apparent contradiction

"Telemetry flows one way" and "the orchestrator sends commands to the edge"
are both true because they are different links with different profiles,
different identities and different trust assumptions. The contradiction only
appears if the two are conflated — which is exactly what the split into two
named profiles prevents.

## 5. Residual risk

- Code execution on the gateway host defeats the software control.
- A compromised signer key permits forged telemetry until the key is revoked.
- The spool is a disk artifact and inherits the host's disk security.
- Traffic analysis on the egress link is not addressed.

See `../security/V3_THREAT_MODEL.md`.
