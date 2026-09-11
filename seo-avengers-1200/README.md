# SEO AVENGERS 1200

Isolated extension layer for the Nexus SEO Avengers system.

## Non-negotiable invariant

This tree never fabricates a per-module implementation just to make the catalog say "1200".

- The namespace is contiguous from **M1 through M1200**.
- **M1-M200** are delegated to the existing `seo-avengers-200` sidecar and are not duplicated here.
- A post-200 module is executable here only when a reviewed algorithm exists in source and has a deterministic receipt contract.
- Every other slot is `RESERVED` and has **no executable handler**.
- Reserved modules are not counted as executions or production capabilities.
- `CONFIG_SEO_AVENGERS_1200` is deny-by-default: only the literal boolean `true` enables this runtime.
- This tree does not modify `apps/cano-penal/**`.

The old generated `seo-avengers-1200-core` artifact is deliberately not imported into the engine. The production path is rebuilt from reviewed algorithms only.

## First integrated vertical slice

The first executable extension set is deliberately small and real:

| Module | Algorithm | State |
| --- | --- | --- |
| M901 | Infrastructure Load Throttle Policy Engine | `IMPLEMENTED_PRODUCTION` |
| M902 | Algorithmic Contradiction Detector | `IMPLEMENTED_PRODUCTION` |
| M1001 | Chromatic Diversity Ratio Auditor | `IMPLEMENTED_PRODUCTION` |
| M1002 | Alt-Context Lexical Alignment Auditor | `IMPLEMENTED_PRODUCTION` |
| M1101 | Edge Evidence Integrity Inspector | `IMPLEMENTED_PRODUCTION` |
| M1102 | Edge Deployment Integrity Gate Policy | `IMPLEMENTED_PRODUCTION` |

M1101 recomputes evidence hashes at the trusted boundary. M1102 consumes the resulting inspected set and fails closed on malformed records, duplicates, missing required modules, unexpected modules, invalid manifests, arithmetic failure, or hash mismatch above policy.

## Runtime chain

```text
existing SEO Avengers 200 evidence (optional upstream input)
                 |
                 v
M901 infrastructure policy ----+
M902 contradiction detector ----+--> receipt/evidence set
M1001 chromatic diversity ------+
M1002 lexical alignment --------+
                                 |
                                 v
                       M1101 integrity inspector
                                 |
                                 v
                       M1102 deployment gate policy
```

The extended runtime never performs a destructive deployment action. M901 and M902 emit recommendations; M1102 emits `deployment_halt_recommended`. The actual deployment controller must explicitly consume that policy before this can be called enforcement.

## Verification

From this directory:

```bash
./scripts/verify.sh
```

The verification suite checks Python syntax, deterministic golden vectors, exact 1200-slot registry cardinality, deny-by-default activation, fail-closed integrity behavior, and the invariant that no reserved slot has an executable handler.

## Next integration slices

Post-200 modules are promoted in small reviewed batches. Each promotion must include its algorithm, input normalization, configuration hash, deterministic receipt/evidence hash, negative tests, and integration data source. No module is promoted from `RESERVED` because of a name or a placeholder implementation.
