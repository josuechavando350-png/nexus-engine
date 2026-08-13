# `@nexus/template-client` — ARCHIVED (NEXUS V1.2)

## Final disposition

This app was moved out of `apps/*` into `archive/_template-client-v1/`
during NEXUS V1.2 hardening, per the disposition analysis in
`docs/architecture/VISUAL_ARCHITECTURE.md` and the V1.2 audit report.
Four options were considered — REFERENCE, ARCHIVE, REMOVE, MIGRATE —
and **ARCHIVE** was chosen deliberately over the others:

- Not REMOVE: this is NEXUS's own product page; deleting it loses real
  history with no replacement ready.
- Not MIGRATE: promoting it to a formal reference implementation
  without a real redesign pass (the same "brand intent → art direction"
  discipline used for `reference-meson`/`reference-alfil`/
  `reference-nexus-bot`) would smuggle the old aesthetic back in with an
  official-sounding label.
- Not REFERENCE (kept in place, just documented): a README warning is a
  barrier of intent, not a structural one — this app sat inside `apps/`
  for an entire phase with a warning already on it, one `cp -r` away
  from becoming the seed again.

Moving it out of the `pnpm-workspace.yaml` `apps/*` glob is a structural
barrier: no normal tooling (`pnpm install`, `pnpm build`, copying an
`apps/` folder as a starting point) can reach it by accident anymore.
`tests/repository-boundaries.test.ts` enforces both that this path
still exists (nothing was deleted) and that `apps/_template-client` no
longer does.

## Role change — NEXUS V1.1 (superseded by the above)

As of NEXUS V1.1 ("Visual Decoupling"), this app stopped being the
starting point for new Client Experiences — `apps/_experience-seed`
replaced it. Its content is NEXUS's own product page (the copy in
`page.tsx` — "Foundation / Composition / Accessibility / Motion" —
markets the engine itself, it was never a blank client starter). That
dual identity is most of why it ended up cloned into every new client
project with only colors changed.

**Do not clone this app's `globals.css`, `page.tsx`, `site-header.tsx`,
or `site-footer.tsx` into a new client project.** Start from
`apps/_experience-seed`.
