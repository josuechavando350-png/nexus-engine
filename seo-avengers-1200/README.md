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

The old generated `seo-avengers-1200-core` artifact is deliberately not imported into the engine. The production path is rebuilt from reviewed algorithms only.

## First integrated vertical slice

| Module | Algorithm | State |
| --- | --- | --- |
| M901 | Infrastructure Load Throttle Policy Engine | `IMPLEMENTED_PRODUCTION` |
| M902 | Algorithmic Contradiction Detector | `IMPLEMENTED_PRODUCTION` |
| M1001 | Chromatic Diversity Ratio Auditor | `IMPLEMENTED_PRODUCTION` |
| M1002 | Alt-Context Lexical Alignment Auditor | `IMPLEMENTED_PRODUCTION` |
| M1101 | Edge Evidence Integrity Inspector | `IMPLEMENTED_PRODUCTION` |
| M1102 | Edge Deployment Integrity Gate Policy | `IMPLEMENTED_PRODUCTION` |

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
        M901 / M902 / M1001 / M1002
               |
               v
        M1101 integrity inspector
               |
               v
        M1102 deployment gate policy
```

The outbox producer and Python worker use a byte-identical typed wire hash across Node/Python. Legacy SEO Avengers 200 evidence can contain real floating-point semantic measurements, so it is transported as a hash-bound canonical JSON string and revalidated under the original Python evidence hash contract after parsing.

The extended runtime never performs a destructive deployment action. M901 and M902 emit recommendations; M1102 emits `deployment_halt_recommended`. The actual deployment controller must explicitly consume that policy before this can be called enforcement.

## Verification

From this directory:

```bash
bash scripts/verify.sh
```

The verification suite covers syntax, deterministic golden vectors, exact 1200-slot registry cardinality, deny-by-default activation, Node/Python wire-hash parity, the SEO Avengers 200 evidence bridge, durable worker behavior, fail-closed integrity handling, and the invariant that no reserved slot has an executable handler.

## How the remaining slots are populated

Promotion is deliberately incremental. The generated 6048-line placeholder artifact is useful only as a rough category inventory; it is **not** treated as executable truth. Each future batch is reconstructed from an actual source contract or a newly reviewed algorithm, tested in isolation, connected to a real data producer, and only then moved from `RESERVED` to `IMPLEMENTED_PRODUCTION`.

This means the suite can grow to 1200 real capabilities without poisoning the engine with repeated formulas, malformed identifiers, fake provider results, or invented telemetry. If a slot has no verified algorithm/data contract yet, leaving it reserved is the correct production behavior.

## Next integration slices

Post-200 modules are promoted in small reviewed batches. Each promotion must include its algorithm, input normalization, configuration hash, deterministic receipt/evidence hash, positive/negative/boundary tests, and a real integration data source. No module is promoted from `RESERVED` because of a name or placeholder implementation.
