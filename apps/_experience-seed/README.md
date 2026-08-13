# `@nexus/experience-seed`

Neutral starting point for a new NEXUS Client Experience.

## What this is

- Next.js + `@nexus/core` wiring (theme bridge, security headers, a11y contracts).
- A theme file (`theme.ts`) that maps only the token roles Core primitives
  actually read (`space.*`, `container.*`, `focus.*`, `motion.*`) — see
  `theme-contract.ts` for why, and `assertRequiredTheme()` for what happens
  if one is missing.
- A page with structural placeholders only.

## What this is not

- Not a design. Rendering this unmodified should look unfinished, not
  presentable. If it looks "done," something leaked art direction into
  a file that shouldn't have it.
- Not `_template-client`. That app is NEXUS's own showcase; it is not the
  origin of new client work anymore. See `apps/_template-client/README.md`.
- Not a place to add Hero/Card/CTA/Navbar/Gallery components with visual
  opinions. Those belong to the Experience you build from this seed, not
  to the seed itself.

## What is intentionally missing

`surface.*`, `content.*`, `accent.*`, `border.*`, `radius.*` token roles
are not set anywhere in this app. That is not an oversight — see
`theme.ts`. Fill them when you turn this into an actual Experience, and
do not reach for the values `_template-client` used as a shortcut; that
is exactly the pattern NEXUS V1.1 exists to stop repeating.
