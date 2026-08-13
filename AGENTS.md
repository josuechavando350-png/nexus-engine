# NEXUS Web Engine — Agent Contract

This repository is the reusable foundation for NEXUS client experiences.

Any human or AI agent modifying this repository must preserve the architectural boundaries, public contracts, accessibility requirements, and validation pipeline described below.

---

## 1. Primary rule

Do not rebuild or replace working architecture without an explicit requirement.

Prefer the smallest compatible change.

Existing green behavior is considered a contract unless the task explicitly authorizes changing it.

---

## 2. Repository architecture

NEXUS is organized as a monorepo.

Primary areas:

- `packages/core`
  Stable, reusable, brand-agnostic engine APIs.

- `packages/experience`
  NEXUS V2 Experience Engine: framework-agnostic Experience DNA, briefs, capabilities, Recipes, originality, Adaptive Luxury and compiler contracts. No React/Next/CSS/brand styling.

- `runtime/`
  NEXUS V3 Industrial Agentic Runtime (Rust). A second execution plane that
  shares this repository and nothing else: no code, no dependencies, no build
  step, no runtime coupling with the Experience plane. `pnpm` never builds it
  and `cargo` never builds the TypeScript workspace. See `runtime/README.md`
  and `docs/architecture/V3_ARCHITECTURE.md`.

  Non-negotiable rules for this tree:
  - No React/Next/TypeScript inside `runtime/`, and no crate may depend on
    `packages/`. `@nexus/core` and `@nexus/experience` may never depend on Rust.
  - `nexus-ontology` must not name a graph database, driver, connection string
    or query language. Backends live only in `nexus-graph`.
  - `nexus-policy::invariants` is non-configurable. The weapon and
    human-targeting prohibitions may not be weakened, made optional or routed
    around. Adding a capability that a hard invariant would deny is not a
    feature request.
  - No arbitrary payload reaches a device. Edge commands are typed, signed,
    expiring and capability-bounded.
  - Never claim exactly-once delivery, physical unidirectionality, a hardware
    data diode, or a certification the project does not hold.
  - `scripts/v3-architecture-gates.mjs` enforces all of the above and runs
    without cargo or network. Run it before proposing changes to `runtime/`.

- `packages/experimental`
  Candidate or experimental APIs.
  Core must never depend on Experimental.

- `apps/_experience-seed`
  Neutral starting point for a new Client Experience. Contains no art
  direction — see `apps/_experience-seed/README.md`.

- `apps/reference-alfil`, `apps/reference-meson`, `apps/reference-nexus-bot`
  Experience probes — deliberate proofs that the same Core sustains
  genuinely different design languages. Not templates, not client
  mirrors.

- `archive/`
  Retired code kept for historical reference only. Not part of the
  active workspace (`pnpm-workspace.yaml` does not glob this
  directory) — nothing here should be treated as a starting point.
  Currently: `archive/_template-client-v1`, the former client seed,
  retired in NEXUS V1.2 (see its `README.md` for why).

- `tests`
  Repository-level architectural tests.

- `docs`
  Architecture and project documentation.

---

## 3. Core boundaries

`packages/core` must remain reusable and independent from client applications.

Core MUST NOT import from:

- `apps/*`
- `packages/experimental`
- client-specific implementations

Foundation is the lowest Core layer.

Foundation MUST NOT depend on higher Core layers such as:

- components
- composition
- motion
- data
- accessibility

Higher layers may depend on Foundation.

Repository boundary tests exist to enforce these rules.

Do not weaken or remove those tests to make a build pass.

---

## 4. Brand-agnostic Core

Do not place client branding inside `packages/core`.

Core must not contain client-specific:

- colors
- logos
- fonts
- imagery
- marketing copy
- domains
- campaign values
- visual identity decisions

Core provides semantic contracts.

Client Experience provides concrete values.

Example:

Core may define:

`surface.base`

A client may map it to:

`#ffffff`

Core must not decide that `surface.base` is white.

---

## 5. Foundation tokens

Semantic design tokens live under:

`packages/core/foundation/tokens`

Use semantic token roles instead of hardcoded visual values in reusable Core APIs.

Token roles include categories such as:

- surface
- content
- accent
- border
- feedback
- focus
- space
- container
- radius
- shadow
- z-index
- motion.duration
- motion.easing

Use existing token helpers such as `tokenVar()` and `tokenName()` when appropriate.

Do not create parallel token naming systems.

---

## 6. Typography

Typography contracts live under:

`packages/core/foundation/typography`

Current semantic roles include:

- display
- heading.1
- heading.2
- heading.3
- heading.4
- body.default
- body.small
- caption
- mono

Do not reintroduce obsolete typography role names.

Use the existing typography helpers and contracts.

---

## 7. Theme Bridge

Theme infrastructure lives under:

`packages/core/foundation/theme`

The Theme Bridge converts semantic NEXUS token roles into CSS custom properties.

Client-specific concrete values belong in the client application.

For the neutral seed, only the REQUIRED token roles are mapped (see
`apps/_experience-seed/src/app/theme-contract.ts` for the
REQUIRED/OPTIONAL/DERIVED/EXPERIENCE-SPECIFIC classification):

`apps/_experience-seed/src/app/theme.ts`

A real Experience (e.g. `apps/reference-meson/src/app/theme.ts`) maps
the Experience-specific roles too — surface, content, accent, border,
radius.

The expected direction is:

Client theme
→ NEXUS Theme Bridge
→ semantic CSS custom properties
→ application styles

Do not duplicate theme values across multiple sources unless explicitly required.

---

## 8. Components

Stable reusable primitives live under:

`packages/core/components`

Current primitives include structural and interactive building blocks such as:

- Box
- Stack
- Cluster
- Grid
- Container
- Section
- Button
- Link
- VisuallyHidden

Prefer composition from existing primitives before creating new abstractions.

Components must remain brand-agnostic.

Components should consume semantic Foundation contracts rather than hardcoded client values.

---

## 9. Accessibility

Accessibility is a first-class NEXUS contract.

Core accessibility APIs live under:

`packages/core/a11y`

Existing contracts include:

- keyboard activation
- ARIA label fallback
- focus-visible behavior
- focus ring declarations
- screen-reader-only content
- polite live regions
- assertive live regions
- reduced-motion detection
- skip-link contracts

Active Experience apps implement accessibility styling locally or render the exported Core accessibility CSS contracts directly.

Do not remove or weaken:

- visible keyboard focus
- reduced-motion support
- semantic landmarks
- skip-link behavior
- screen-reader support

The conventional primary content target in active Experiences is:

`#main-content`

---

## 10. Security

Security defaults live under:

`packages/core/foundation/config`

Security configuration must remain generic and reusable.

Do not add client-specific domains to reusable Core security contracts unless the task explicitly requires a configurable mechanism.

Active Next.js Experience apps consume Core security configuration through their local `next.config.ts`.

---

## 11. Client Experience ownership

Files under `apps/*` may define concrete client experience decisions.

This includes:

- concrete theme values
- page composition
- content
- brand-specific styling
- client-specific integrations

Client applications may depend on Core.

Core must never depend on client applications.

---

## 12. Public API

Respect `packages/core/package.json` exports.

Do not rely on internal package paths that are not intentionally exported.

When a new stable capability must be consumed externally:

1. implement it in the correct Core layer
2. expose it through the appropriate module entrypoint
3. update package exports when required
4. add tests
5. validate the consuming application

Do not expose Experimental APIs from the stable Core root without explicit authorization.

---

## 13. Tests

New stable behavior should have tests.

Current validation includes:

- lint
- typecheck
- tests
- build

Architectural tests must remain intact.

Never solve a failing test by deleting, skipping, weakening, or bypassing the test unless the specification explicitly changes the underlying contract.

---

## 14. CI

GitHub Actions validation is defined under:

`.github/workflows/tests.yml`

The project currently uses:

- Node.js 24
- pnpm 10.15.0

The repository `packageManager` and CI pnpm version must remain aligned.

---

## 15. Required validation

Before declaring a repository change complete, the following commands must pass:

`pnpm lint`

`pnpm typecheck`

`pnpm test`

`pnpm build`

A successful implementation should result in the GitHub Actions `validate` job passing.

Do not claim APPROVE when validation is known to be failing.

---

## 16. Working rules for AI agents

Before modifying code:

1. inspect the current implementation
2. identify the smallest required delta
3. preserve existing approved behavior
4. verify architectural boundaries
5. avoid unrelated refactors

While modifying code:

- do not invent missing requirements
- do not silently redesign the architecture
- do not introduce unnecessary dependencies
- do not duplicate existing utilities
- do not hardcode client identity into Core
- do not weaken accessibility
- do not bypass security contracts
- do not bypass repository boundary tests

After modifying code:

1. summarize files changed
2. explain the architectural reason
3. report validation results
4. explicitly report unresolved risks or failures

---

## 17. Experimental work

Candidate APIs belong in:

`packages/experimental`

Experimental may depend on Core.

Core must never depend on Experimental.

Promotion from Experimental to Core must be deliberate.

Do not silently move experimental behavior into the stable API.

---

## 18. Change discipline

A task should normally modify only files required by its scope.

If an unrelated issue is discovered:

- report it
- explain the risk
- do not automatically expand scope unless necessary for correctness

Prefer additive changes over destructive rewrites.

---

## 19. Definition of done

A NEXUS change is complete when:

- the requested behavior exists
- architectural boundaries remain intact
- public exports are intentional
- accessibility remains intact
- no unnecessary client-specific values enter Core
- relevant tests exist
- lint passes
- typecheck passes
- tests pass
- build passes
- GitHub Actions is green

---

## 20. Guiding principle

NEXUS should make future client experiences faster to build without making Core dependent on any one client.

Stable foundation in Core.
Concrete experience in apps.
Experimental ideas outside Core until promoted deliberately.

---

## 21. NEXUS V1.2 additions (addendum, does not renumber the sections above)

Added to Core during V1.2 hardening, all additive, all backward
compatible:

- `SKIP_LINK_CSS`, `FOCUS_VISIBLE_CSS` in `packages/core/a11y` — same
  pattern as the pre-existing `SR_ONLY_CSS`/`REDUCED_MOTION_CSS`.
- Capability signal constants and SSR-safe helpers in
  `packages/core/a11y` (`POINTER_COARSE_QUERY`, `POINTER_FINE_QUERY`,
  `HOVER_NONE_QUERY`, `HOVER_HOVER_QUERY`, `REDUCED_DATA_QUERY`,
  `hasCoarsePointer()`, `hasHoverCapability()`) — reliable media-query
  signals only. Do not add `navigator.deviceMemory`,
  `navigator.connection`, or any other unreliable hardware/network
  inference here; a test in `a11y.test.ts` guards against it.
- `NEXUS_RESET_CSS` in `packages/core/foundation/reset` — box-model
  normalization only, promoted after 4 independent hand-written
  occurrences at the Experience layer. Never add a color, font-family,
  or fallback value to this string; a test in `reset.test.ts` guards
  against it.
- `packages/core/a11y/a11y.css` was renamed from the previously broken
  `a11y . css` (literal spaces, did not match the package.json export
  path) and its `var(--space-3)` legacy reference was corrected to
  `var(--space-md)`. This file must stay in sync with
  `SR_ONLY_CSS + SKIP_LINK_CSS + FOCUS_VISIBLE_CSS + REDUCED_MOTION_CSS`
  from `a11y/index.ts` — guarded by a test in `a11y.test.ts`.


---

## 22. NEXUS V2 Experience Engine boundaries

`packages/experience` is orchestration IP, not visual implementation.

It MUST NOT import:

- React or React subpaths
- Next.js or Next.js subpaths
- `@nexus/core`
- any `apps/*` implementation

Apps may consume both Core and Experience Engine. Core must never import Experience Engine.

Experience Engine contracts must remain UI-agnostic:

- Capability definitions describe outcomes and journey roles, never components.
- Recipes describe narrative stages and abstract composition moves, never Hero/Card/Button variants.
- Experience DNA describes justified intent, never CSS or component selections.
- The compiler outputs a plan, not JSX.
- `StyleFingerprintV2` must not rely on color/palette to decide originality.

Runtime guards and repository tests enforce these boundaries. Do not weaken them to make a design easier to implement.

## 23. V2 Design Originality rule

Every concrete Experience still answers:

> Why does THIS Experience need this decision?

V2 tooling may detect structural similarity, but it must not force novelty for novelty's sake. Similarity may be justified; justification must stay explicit and the similarity score must remain visible.

The mandatory human test is documented in `docs/research/HUMAN_VISUAL_DIVERSITY_TEST_V2.md`. Structural tests do not replace human perception.


## V4 non-negotiable cognitive boundary
No V4 cognitive crate may directly emit EdgeTask or bypass nexus-policy/simulation/approval. Models, memories, MCP/tool adapters and agents are untrusted inputs; authority remains in typed NEXUS contracts and V3 safety gates.

## V6 distributed-runtime contract

- Distribution decides placement and replication, never authorization.
- No V6 crate may construct or dispatch `EdgeTask` directly.
- Cluster membership uses monotonic epochs; stale tombstoned nodes require explicit re-enrollment.
- Federation grants are explicit, scoped, expiring and non-transitive.
- Offline reconciliation must never invent permission or duplicate a committed physical effect.
- Update staging requires verified artifact identity plus rollback protection; rollout health gates are NEXUS semantics.
- Consensus, discovery, mesh, scheduler and update providers remain replaceable adapters.
