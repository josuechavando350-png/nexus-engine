# Invariant enforcement register

This register prevents source-string checks from being represented as
behavioral certification. `INVARIANT_NOT_ENFORCEABLE` means exactly that: the
repository currently has no executable observation that proves the claim.

| Invariant | Status | Executable evidence or reason |
| --- | --- | --- |
| Two independent Next.js 15.5.23 builds produce byte-for-byte identical output | INVARIANT_NOT_ENFORCEABLE | Next.js does not document this guarantee. Reproducible-build issue [vercel/next.js#63201](https://github.com/vercel/next.js/issues/63201) remains open; Next.js 15.5.23 generates Preview Mode credentials with `crypto.randomBytes()` in [`preview-key-utils.ts`](https://github.com/vercel/next.js/blob/v15.5.23/packages/next/src/build/preview-key-utils.ts#L33-L38); and the supported deployment guidance is to use [`generateBuildId`](https://nextjs.org/docs/app/api-reference/config/next-config-js/generateBuildId) so the same build is used in every container. NEXUS therefore does not claim that two independent builds are byte-identical. Review if Next.js publishes and implements a reproducible-build contract. |
| Built web artifact is distributed without byte changes | ENFORCED | `scripts/build-artifact.mjs` builds once and records every file's raw size and SHA-256 plus an aggregate digest. `scripts/verify-artifact.mjs` fails closed unless downloaded bytes, file set, digest and source revision match that manifest. `tests/artifact-identity.test.ts` proves an altered downloaded artifact makes the verifier exit non-zero. |
| V4 replay cannot dispatch physical work | ENFORCED | `nexus-durable` Rust unit tests exercise replay mode; the Rust workspace test job runs them. |
| V4 planner cycles and reasoning budgets remain bounded | ENFORCED | `nexus-planner` and `nexus-reasoning` Rust unit tests exercise cycle and budget rejection. |
| V4 model and memory providers remain replaceable | INVARIANT_NOT_ENFORCEABLE | Trait-name/source presence is architecture inspection, not behavior. No provider conformance suite exists yet. |
| V5 authorization is tenant/scoped | ENFORCED | `nexus-authz` Rust unit tests exercise cross-tenant and scope denial. |
| V5 control-plane authorization and audit cannot be bypassed | INVARIANT_NOT_ENFORCEABLE | The control-plane crate has no behavioral conformance suite covering the combined claim. |
| V5 secrets never expose plaintext | INVARIANT_NOT_ENFORCEABLE | Absence of a source field cannot prove absence from every runtime/debug/serialization path. |
| V6 rollback protection | ENFORCED | `nexus-update` Rust unit tests reject rollback counters. |
| V6 distribution evidence and fleet rollout limits | INVARIANT_NOT_ENFORCEABLE | The affected distributed/fleet crates lack a behavioral conformance test for the combined invariant. |
| V7 descriptors never claim production proof | ENFORCED | `tests/v7-boundaries.test.ts` executes the public TypeScript contract; `nexus-kernel` Rust unit tests execute the Rust contract. |
| V7 TypeScript/Rust descriptors remain semantically identical | INVARIANT_NOT_ENFORCEABLE | Cross-language source matching is not execution. A shared generated contract or cross-plane conformance adapter is required. |
| V8 Creative Vault immutable identity, digest, lineage and scope | ENFORCED | `packages/creative/tests/vault.test.ts` exercises success plus digest, size, version, lineage, rights and cross-scope failures. |
| V8 Art Direction Memory is evidence-only, scoped and retention bounded | ENFORCED | `packages/creative/tests/memory.test.ts` exercises authority, retention, supersession, scope leakage and backend failure. |
| V8 creative evidence has scoped/time-aware identity and explicit sink failure | ENFORCED | `packages/creative/tests/evidence.test.ts` executes identity changes and failed delivery. |
| V8 benchmark execution stores real raw samples and rejects invalid measurements | ENFORCED | `packages/benchmark/benchmark.test.ts` executes workloads and checks raw samples, determinism and negative inputs. |
| V8 framework/vendor/browser/Rust neutrality | INVARIANT_NOT_ENFORCEABLE | Import/source scanning is a useful architecture lint, but it is not behavioral proof. Dependency policy needs a dedicated graph boundary tool and must not be described as runtime certification. |
| V8 planned maturity wording, optional-technology wording and version-scope prose | INVARIANT_NOT_ENFORCEABLE | These are documentation assertions, not executable product invariants. They are intentionally not gates. |
| V8 accessible degradation for every adapter | INVARIANT_NOT_ENFORCEABLE | Individual motion/accessibility tests exist, but there is no conformance suite covering every optional adapter. |

## Build-once artifact identity

NEXUS enforces **build once, hash once, distribute the exact same artifact**.
`pnpm build` performs one build, stages its exact bytes under
`.artifacts/web-build`, and writes `.artifacts/web-build-identity.json`. CI
uploads that pair, downloads it again, and runs `pnpm verify:artifact` against
the exact source revision. Added, removed, or byte-modified files fail the
verification. This proves artifact identity across the distribution boundary;
it does not represent a second independent Next.js build as reproducibility
evidence.

The enforceable inputs remain fail-closed: frozen lockfiles and pinned tool
versions, hermetic build inputs, fixed build ID, fixed Server Actions encryption
key, semantic manifest identity, and a clean tracked worktree after NEXUS-owned
outputs are produced.

## Generated JSON normalization

The artifact manifest records an additional semantic identity for generated
`.json` files by recursively sorting object keys before hashing. JSON object key
order and formatting carry no semantic information, so this is normalization
rather than an invariant exception.
Array order, property names, property presence, value types and values remain
significant: adding, removing or changing any of them still fails the gate.

The Preview Mode exception remains narrowly scoped to
`preview.previewModeId`, `preview.previewModeSigningKey`, and
`preview.previewModeEncryptionKey` in `.next/prerender-manifest.json`. Next.js
15.5.23 creates only those credential values with `crypto.randomBytes()` and
does not expose a supported API to fix them. The semantic identity records every
application of that declared exception. Raw artifact identity is never
canonicalized: the bytes built once must be the bytes distributed.

The removed `tests/runtime-invariants.test.ts`, `tests/v4-boundaries.test.ts` and
`tests/v5-boundaries.test.ts` only searched source strings. Their green result
must not be used as certification evidence. V8 behavioral coverage is supplied
by the executable suites listed above; deleted plan/prose assertions remain
explicitly non-enforceable rather than silently passing.
