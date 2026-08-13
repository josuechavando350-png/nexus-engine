# ADR 0002 — Visual decoupling: seed replaces template as client origin

Status: Accepted (Phase 1 scope only)

`apps/_template-client` was both NEXUS's own product page and the de
facto starting point for every new Client Experience, cloned with colors
changed. `@nexus/core` audited as agnostic; the coupling was entirely in
that app's composition CSS and page content, most of which does not even
consume Core's own typography/radius token contracts.

Decision: introduce `apps/_experience-seed` as the only sanctioned origin
for new Experiences. It contains infrastructure and required-only theming,
zero composition CSS. `_template-client` is not deleted or moved in this
phase; it is documented (`apps/_template-client/README.md`) as no longer
the client origin, pending a future decision on whether it becomes a
reference implementation.

Not decided by this ADR: Recipes, Experience DNA, Capability decoupling,
Anti-Template, Forge, Certify, or any Core change. See
`docs/architecture/VISUAL_ARCHITECTURE.md`.
