# @nexus/passive-bot-defense

Passive bot-risk diagnostics from trusted TLS/edge evidence. JA3/JA4 are signals, never identities. Missing fingerprints add no risk. The default policy can observe or rate-limit but cannot deny; `DENY` requires explicit opt-in plus composed evidence from at least two independent risk families.

## Trust boundary

JA3/JA4 values are accepted only as fields supplied by a trusted edge/runtime adapter or by an HMAC-verified signed edge envelope. Public request headers are not a TLS trust boundary. Raw `SIGNED_EDGE` JSON is rejected and must pass `verifyEnvelope()` first.

Verified legitimate bots or signed agents bypass heuristic mitigation. This package does not use CAPTCHA, canvas/WebGL/audio/font fingerprinting, persistent device identifiers, or a JA4 match as standalone blocking evidence.

`subjectToken()` creates an epoch-rotating HMAC pseudonym from a source IP and optional JA4 value. The raw IP is not carried into `PassiveSignal` or `PassiveDecision` evidence.

## Replay and deployment limits

Signed envelopes are HMAC-SHA256 bound to key id, method, path, a maximum 60-second TTL, canonical payload bytes, the carried signal digest and a nonce. `InMemoryReplayStore` is only suitable for controlled tests or a single process. Distributed deployment requires a shared atomic `ReplayStore`; this repository does not claim that such external state or a live TLS edge is deployed.

## Operational consumer

```bash
node scripts/audit-passive-bot-defense.mjs --input /path/to/trusted-edge-signal.json
```

For signed edge evidence, provide `--envelope`, `--secret-env`, `--method`, and `--path`. Missing runtime input or secrets return `UNAVAILABLE`; absence of edge infrastructure is never converted into PASS.
