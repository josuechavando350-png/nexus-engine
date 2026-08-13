/**
 * Ambient module declaration for CSS side-effect imports
 * (`import "./x.css";`, no binding).
 *
 * Root cause of TS2882 under TypeScript 6: `pnpm typecheck` runs a bare
 * `tsc --noEmit` per app — no webpack/Turbopack loader is involved, so
 * TypeScript has no idea what a `.css` specifier resolves to and, as of
 * TS6, treats that as a hard error for side-effect imports instead of
 * silently ignoring it. Next.js's own `next-env.d.ts` does not declare
 * this (verified: it only references `next` and
 * `next/image-types/global`, neither covers `*.css`) — every real
 * Next.js project needs this declaration somewhere for a standalone
 * `tsc` run to succeed; Next's bundler handles the actual CSS at build
 * time regardless of what TypeScript thinks the module is.
 *
 * Side-effect only: nothing in this app imports a named/default binding
 * from a `.css` file (no CSS Modules usage), so no typed classname map
 * is declared here — just enough to make the import resolvable.
 */
declare module "*.css";
