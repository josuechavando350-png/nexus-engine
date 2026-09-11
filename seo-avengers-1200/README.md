# SEO AVENGERS 1200

Isolated extension layer for the Nexus SEO Avengers system.

## Non-negotiable invariant

This tree never fabricates a per-module implementation just to make the catalog say "1200".

- The namespace is contiguous from **M1 through M1200**.
- **M1-M200** are delegated to the existing `seo-avengers-200` sidecar and are not duplicated here.
- A post-200 module is executable here only when a reviewed algorithm exists in source and has a deterministic receipt contract.
- Every other slot is `RESERVED` and has **no executable handler**.
- Reserved modules are not counted as executions or production capabilities.
- `CONFIG_SEO_AVENGERS_1200` is deny-by-default and additionally requires `CONFIG_SEO_AVENGERS_200=true`.
- This tree does not modify `apps/cano-penal/**`.

The old generated `seo-avengers-1200-core` artifact is deliberately not imported into the engine. Its repeated/generated formulas and malformed identifiers are treated only as historical inventory hints, never as production implementations.

## Promoted executable modules

| Module | Algorithm | State |
| --- | --- | --- |
| M601 | Internal Content Similarity Detector | `IMPLEMENTED_PRODUCTION` |
| M602 | Content Decay Review Candidate Detector | `IMPLEMENTED_PRODUCTION` |
| M701 | Unlinked Brand Mention Detector | `IMPLEMENTED_PRODUCTION` |
| M702 | Brand Prominence Share Monitor | `IMPLEMENTED_PRODUCTION` |
| M801 | Strict Local NAP Consistency Auditor | `IMPLEMENTED_PRODUCTION` |
| M802 | Local Geolocation L1 Deviation Monitor | `IMPLEMENTED_PRODUCTION` |
| M901 | Infrastructure Load Throttle Policy Engine | `IMPLEMENTED_PRODUCTION` |
| M902 | Algorithmic Contradiction Detector | `IMPLEMENTED_PRODUCTION` |
| M1001 | Chromatic Diversity Ratio Auditor | `IMPLEMENTED_PRODUCTION` |
| M1002 | Alt-Context Lexical Alignment Auditor | `IMPLEMENTED_PRODUCTION` |
| M1101 | Edge Evidence Integrity Inspector | `IMPLEMENTED_PRODUCTION` |
| M1102 | Edge Deployment Integrity Gate Policy | `IMPLEMENTED_PRODUCTION` |

**Current truth:** the extension contributes 12 reviewed executable post-200 modules. M1-M200 remain owned by the existing Avengers 200 implementation. The other 988 post-200 slots remain reserved and non-executable.

M601 uses bounded pairwise Jaccard similarity over deterministic lexical shingles and is worker-only. M602 compares like-for-like traffic windows and only recommends review. M701 parses per-document HTML, ignores non-content/hidden text under its parser contract, inspects actual anchors, and never invents backlinks. M702 measures share only inside the explicitly supplied tracked corpus and refuses undersized samples. M801 compares normalized NAP fields against an explicit canonical business record. M802 uses integer microdegree L1 deviation and does not claim meter distance.

The extension also contains a **verification bridge**, not a new fake module, for real `module_evidence` already emitted by SEO Avengers 200. The bridge reproduces the existing 200 hash contract before wrapping a verified record into a normal receipt. A mismatch becomes invalid evidence and therefore reaches M1101/M1102 as fail-closed input.

## Runtime chain

```text
native Nexus pipeline
      |
      | RENDER PASS
      v
isolated Avengers sidecars
      |
      +--> existing Avengers 200 path
      |
      +--> 1200 durable outbox
               |
               v
        verified 200-evidence bridge
               |
        M601 / M602
        M701 / M702
        M801 / M802
        M901 / M902
        M1001 / M1002
               |
               v
        M1101 integrity inspector
               |
               v
        M1102 deployment gate policy
```

Every promoted pre-gate module emits a normal receipt. The public service composes all ten pre-gate receipts into one evidence set, M1101 recomputes their integrity, and M1102 evaluates the exact required manifest. Reserved modules never enter the dispatcher or denominator.

The outbox producer and Python worker use a byte-identical typed wire hash across Node/Python. Legacy SEO Avengers 200 evidence can contain real floating-point semantic measurements, so it is transported as a hash-bound canonical JSON string and revalidated under the original Python evidence hash contract after parsing.

The extended runtime never performs a destructive deployment action. M601/M602/M701/M702/M801/M802/M901/M902 are detectors, monitors, auditors, or recommendations. M1102 emits `deployment_halt_recommended`; the actual deployment controller must explicitly consume that policy before this can be called enforcement.

## Verification

From this directory:

```bash
bash scripts/verify.sh
```

The verification suite covers syntax, deterministic golden vectors, exact 1200-slot registry cardinality, the twelve-module production allowlist, deny-by-default activation, Node/Python wire-hash parity, the SEO Avengers 200 evidence bridge, durable worker behavior, fail-closed integrity handling, and the invariant that no reserved slot has an executable handler.

## How the remaining slots are populated

Promotion is deliberately incremental. Each future batch is reconstructed from an actual source contract or a newly reviewed algorithm, tested in isolation, connected to a real data producer, and only then moved from `RESERVED` to `IMPLEMENTED_PRODUCTION`.

This means the suite can grow to 1200 real capabilities without poisoning the engine with repeated formulas, malformed identifiers, fake provider results, or invented telemetry. If a slot has no verified algorithm/data contract yet, leaving it reserved is the correct production behavior.
