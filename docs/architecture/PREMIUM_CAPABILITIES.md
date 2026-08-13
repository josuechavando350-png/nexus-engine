# NEXUS Premium Capabilities — inventory

Status: living document. V2 now implements a **formal capability registry** in `packages/experience/premium-capabilities.ts` plus an execution resolver in `packages/experience/adaptive-luxury.ts`. Rendering adapters (WebGL/WebGPU/video/etc.) remain Experience-owned and are not universal dependencies.

Principle: premium capabilities are things an Experience can reach for
when its art direction calls for them — never defaults, never universal
dependencies, never a "christmas tree" of effects turned on because
they exist. Premium = the right technology, for the right Experience,
executed correctly, without compromising accessibility, security, or
performance.

| Capability | Classification | Note |
|---|---|---|
| View Transitions API | OPTIONAL PREMIUM | Needs a fallback; not universal yet |
| CSS animations | PRODUCTION BASELINE | Already in use across the 3 probes |
| Scroll-driven animations (CSS) | OPTIONAL PREMIUM | Uneven browser support |
| Variable fonts | OPTIONAL PREMIUM | Depends on the Experience's typography choice |
| Fluid typography (`clamp()`) | PRODUCTION BASELINE | Already in use |
| Container queries | PRODUCTION BASELINE | Wide support, no default imposed |
| CSS subgrid | OPTIONAL PREMIUM | Directly useful for the asymmetric-column gap documented in `GRID_PRIMITIVE_LIMITATIONS.md` |
| Image optimization / AVIF / WebP | PRODUCTION BASELINE | Native to Next.js |
| Responsive image pipelines | PRODUCTION BASELINE | Same |
| Video backgrounds / cinematic media | OPTIONAL PREMIUM | Real cost — must go through the Capability Budget |
| WebGL / WebGPU / shaders / particles / 3D / canvas | EXPERIMENTAL LAB | High cost, WebGPU not universal, needs isolation + fallback before approaching baseline |
| Parallax | OPTIONAL PREMIUM | Must always respect `prefers-reduced-motion` |
| Spatial interaction / pointer-reactive surfaces / tactile microinteractions | OPTIONAL PREMIUM | Gate behind `hover: hover` / `pointer: fine` — see `ADAPTIVE_LUXURY.md` |
| Haptics | EXPERIMENTAL LAB | Support too inconsistent across devices/browsers today |
| Ambient motion / page transitions / sophisticated splash | OPTIONAL PREMIUM | Never a default |
| Progressive enhancement | PRODUCTION BASELINE | A principle, not a library — already how every current app is built (zero client components) |
| Adaptive experiences by device | OPTIONAL PREMIUM | Only via the reliable signals in `ADAPTIVE_LUXURY.md` |
| Reduced-motion degradation | PRODUCTION BASELINE | Already implemented consistently |
| Data-saver degradation | OPTIONAL PREMIUM | Real but not universal support (`prefers-reduced-data`) |
| Performance-aware effects | OPTIONAL PREMIUM | Gated by the Capability Budget |
| Offline / PWA | OPTIONAL PREMIUM | Makes sense for some Experiences, not all |
| Streaming (Next.js) | PRODUCTION BASELINE | Native to the framework already in use |
| Modern caching | PRODUCTION BASELINE | Same |
| Structured data | PRODUCTION BASELINE | Low cost, high SEO value — should be close to default practice, not "premium" in spirit |
| Rich metadata / social previews | PRODUCTION BASELINE | Same |
| Analytics instrumentation | OPTIONAL PREMIUM | Depends on consent architecture per Experience |
| Observability / error reporting | PRODUCTION BASELINE | Infrastructure, not aesthetics — should be standard |
| Privacy/consent architecture | PRODUCTION BASELINE | Non-negotiable the moment any analytics exists |
| Security hardening / CSP | PRODUCTION BASELINE | Implemented in V1.2 — `NEXUS_SECURITY_HEADERS_BASE` + `buildCsp()` |
| SRI (Subresource Integrity) | OPTIONAL PREMIUM | Only relevant once a third-party script/style is loaded from a CDN — none currently are |
| Dependency/security auditing | PRODUCTION BASELINE (goal) | `pnpm audit` belongs in CI; not runnable in this sandbox — see `scripts/quality-gates.mjs` "Dependency health" gate |
| Supply-chain protections | PRODUCTION BASELINE (goal) | Same — CI-dependent, pending a networked environment |

## V2 implementation boundary

The V2 registry describes purpose, cost, reliable-signal requirements and fallback strategy for premium capabilities. NEXUS still does not install a universal WebGL/WebGPU/3D runtime. A concrete Experience chooses and owns the implementation only when its DNA and capability budget justify the cost.
