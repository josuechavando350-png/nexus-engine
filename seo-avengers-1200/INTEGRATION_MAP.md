# SEO Avengers 1200 — Integration Map

## Authority and isolation

The native Nexus pipeline remains the delivery authority. `seo-avengers-1200/**` is an opt-in sidecar extension and does not replace or mutate native generation, rendering, capture, judging, repair, or certification behavior.

Activation requires both project flags to be the literal boolean `true`:

```json
{
  "nexus": {
    "CONFIG_SEO_AVENGERS_200": true,
    "CONFIG_SEO_AVENGERS_1200": true
  }
}
```

If either flag is absent, false, malformed, or unreadable, the extension is OFF. The outbox producer checks the switches before repository discovery or artifact creation. The outbox worker checks them again before consuming queued work.

The dedicated CI gate accepts branch changes only under `seo-avengers-1200/**` plus `.github/workflows/seo-avengers-1200-isolated-check.yml`. Any other changed path fails the isolation check, with `apps/cano-penal/**` explicitly forbidden.

## Current connection path

```text
Nexus native pipeline
  |
  | real RENDER PASS only
  v
seo-avengers-1200 engine overlay
  |
  +--> existing SEO Avengers 200 generated-copy outbox
  |
  +--> SEO Avengers 1200 extension outbox
          |
          | typed Node/Python hash-bound envelope
          v
      process-outbox.py
          |
          +--> verify/bridge real SEO Avengers 200 module_evidence
          |
          v
      SeoAvengers1200Runtime
          |
          +--> M901 infrastructure load throttle policy
          +--> M902 algorithmic contradiction detector
          +--> M1001 chromatic diversity ratio auditor
          +--> M1002 alt-context lexical alignment auditor
          |
          v
      M1101 trusted-boundary evidence recomputation
          |
          v
      M1102 deployment integrity gate policy
          |
          v
      immutable result artifact
```

The overlay does not synthesize telemetry or image measurements from unrelated Nexus stage data. It queues the extended runtime only when `spec.seoAvengers1200Input` is explicitly supplied by a real upstream collector. Missing typed source data means no extended job is queued.

## 1200-slot registry contract

- M1-M200: `DELEGATED_TO_SEO_AVENGERS_200`.
- M901, M902, M1001, M1002, M1101, M1102: executable production implementations in the extension runtime.
- Every other slot through M1200: `RESERVED`, with no executable handler.

The registry is a namespace/catalog contract, not a claim that 1200 algorithms are implemented. A reserved module cannot execute and is not counted as a production capability.

## Evidence bridge

Normal 1200 receipts cross M1101 as:

```json
{
  "target_module_id": "M901",
  "reported_evidence_hash": "sha256:<64 lowercase hex>",
  "receipt_payload": {}
}
```

M1101 removes an embedded `evidence_hash` before recomputation, verifies that the receipt module matches `target_module_id`, validates exact SHA-256 syntax, rejects malformed or duplicate evidence, and compares the independently recomputed digest with the reported digest.

The existing SEO Avengers 200 semantic runtime already emits `module_evidence` records under keys such as `M51`. The 1200 transport accepts that real mapping as `seo_avengers_200_module_evidence`; Node serializes it into a hash-bound JSON string so legacy floating-point evidence is not coerced into the integer-only cross-runtime envelope contract. Python reparses the string and independently reproduces the existing SEO Avengers 200 hash formula:

```text
canonical_hash({"module_id": numeric_id, **record_without_evidence_hash})
```

Only a matching legacy hash is wrapped into a normal bridge receipt. Malformed or mismatched legacy evidence is converted into an invalid evidence row so M1101/M1102 fail closed; it is never silently promoted.

The outer Node/Python outbox envelope uses a separate typed byte encoding (`runtime/wire.py` and `envelopeHashV1`) rather than relying on implementation-specific JSON number/string serialization. Keys are constrained, strings are framed by UTF-8 byte length, and numbers in the normal extension payload/config are restricted to the shared JS/Python safe-integer range.

M1102 validates an exact required module manifest and fails closed on missing, unexpected, malformed, duplicate, or integrity-mismatched evidence according to its policy. It emits a recommendation; it does not itself perform a deployment mutation.

## Promotion rule for M201-M1200

A reserved module may be promoted only with all of the following present in source control:

1. a real input/data source or an explicit `INSUFFICIENT_DATA` path;
2. a named, reviewable algorithm with no fabricated provider result;
3. deterministic normalization and configuration hashing;
4. receipt/evidence hashing and explicit reason codes;
5. positive, negative, boundary, and fail-closed tests;
6. a declared execution layer and connection to the preceding/next evidence boundary;
7. no request-path blocking unless the native pipeline contract explicitly approves it;
8. no destructive action hidden behind a detector/recommendation name.

The saved generated 1200-module artifact is not a production source. It is excluded from this path because generated placeholders and malformed identifiers would violate the promotion rule.

## Verification

`seo-avengers-1200/scripts/verify.sh` checks syntax, golden vectors, the verified SEO Avengers 200 bridge, Node/Python wire-hash parity, outbox processing, the 1200-slot honesty invariant, deny-by-default activation, wrapper syntax/direct import targets, and absence of a client-specific `apps/cano-penal` dependency in executable extension code.
