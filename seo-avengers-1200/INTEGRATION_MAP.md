# SEO Avengers 1200 — Integration Map

## Authority and isolation

The native Nexus pipeline remains the delivery authority. `seo-avengers-1200/**` is an opt-in sidecar extension and does not replace or mutate native generation, rendering, capture, judging, repair, or certification behavior.

Activation requires both project flags to be the literal boolean `true`: `CONFIG_SEO_AVENGERS_200` and `CONFIG_SEO_AVENGERS_1200`. Missing, false, malformed, or unreadable configuration is authoritative OFF. The producer checks activation before creating outbox work and the worker checks it again before consuming queued work.

The dedicated CI gate allows only `seo-avengers-1200/**` plus its dedicated workflow. Client code, including `apps/cano-penal/**`, remains outside this integration path.

## Current connection path

```text
Nexus native pipeline
  |
  | real RENDER PASS only
  v
seo-avengers-1200 engine overlay
  |
  +--> existing SEO Avengers 200 sidecar/evidence
  |
  +--> SEO Avengers 1200 hash-bound outbox
          |
          v
      asynchronous worker
          |
          +--> verify/bridge real SEO Avengers 200 module_evidence
          |
          +--> M201/M202 search performance
          +--> M301/M302 competitive keyword coverage
          +--> M401/M402 traffic change + volatility
          +--> M501/M502 revenue projection + attribution coverage
          +--> M601/M602 content quality
          +--> M701/M702 external brand corpus
          +--> M801/M802 local consistency
          +--> M901/M902 runtime/meta policy
          +--> M1001/M1002 visual-search signals
          |
          v
      M1101 trusted-boundary evidence recomputation
          |
          v
      M1102 exact-manifest deployment gate policy
          |
          v
      immutable result artifact
```

The wrapper does not manufacture Search Console, competitor, traffic, revenue, external-corpus, local, image, or infrastructure observations from unrelated Nexus state. Extended jobs execute only against explicitly supplied typed datasets from real upstream collectors. Missing data produces `INSUFFICIENT_DATA`, not fabricated measurements.

## 1200-slot registry contract

- M1-M200: `DELEGATED_TO_SEO_AVENGERS_200`.
- M201, M202, M301, M302, M401, M402, M501, M502, M601, M602, M701, M702, M801, M802, M901, M902, M1001, M1002, M1101, M1102: `IMPLEMENTED_PRODUCTION` in the extension.
- Every other post-200 slot through M1200: `RESERVED`, with no executable handler.

The current extension therefore has 20 reviewed post-200 implementations and 18 pre-gate receipts. Registry cardinality is not used to inflate production capability counts.

## Evidence and trust boundary

Every promoted module emits a deterministic receipt. All 18 pre-gate receipts, plus any independently verified legacy Avengers 200 evidence, enter a single M1101 pass. M1101 removes an embedded `evidence_hash` before recomputation, validates exact SHA-256 syntax and module identity, rejects malformed/duplicate records, and compares the recomputed digest with the reported digest.

The Avengers 200 bridge independently reproduces its existing semantic `module_evidence` hash contract before wrapping a legacy record. A bad legacy hash is emitted as invalid evidence, never silently promoted.

The Node/Python outbox envelope uses a typed byte encoding rather than implementation-specific JSON number formatting. Normal extension payload/config numbers are restricted to shared safe integers. Legacy semantic evidence may contain real floats, so it is transported as a hash-bound canonical JSON string and verified under its original Python contract after parsing.

M1102 consumes the exact expected pre-gate manifest. Missing, unexpected, malformed, duplicate, or integrity-mismatched evidence cannot dilute the denominator and triggers fail-closed behavior according to the policy. M1102 emits a halt recommendation; actual deployment mutation remains outside this runtime.

## Promotion rule

A reserved slot moves to `IMPLEMENTED_PRODUCTION` only when source control contains: a real input contract; a reviewable algorithm; deterministic normalization/config hashing; receipt/evidence hashing; positive/negative/boundary tests; a declared execution layer; a connection into the evidence chain; and no hidden destructive action.

The saved generated 1200-module artifact is not production source. Its repeated formulas and malformed identifiers are deliberately excluded.

## Verification

`seo-avengers-1200/scripts/verify.sh` checks syntax, golden vectors, all promoted batches, the verified Avengers 200 bridge, Node/Python wire parity, durable outbox processing, exact registry/allowlist counts, deny-by-default activation, wrapper import targets, and executable-source isolation from client apps.
