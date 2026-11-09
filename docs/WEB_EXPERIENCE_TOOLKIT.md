# Web Experience Toolkit — integration contract

Status: **experimental, opt-in**. Four source repositories are integrated as
version-locked Git submodules under `vendor/web-experience/`. Gallery and carousel
lifecycle adapters are exported from `@nexus/experimental/web-experience`.
Scroll Rig and SeamTransitions remain app-owned visual integrations: retaining
their complete sources is not a claim that all effects are production-certified.

## Architecture

Core, the UI-agnostic Experience Engine and the Rust runtime are unchanged. Client
apps own concrete composition, dependencies, CSS, content and asset rights. The
new adapters use provider injection: a client imports its chosen dependency and
passes a factory to NEXUS. This avoids putting React, Three, GSAP or gallery/carousel
code in every site's bundle. No registry dependency or root lockfile is changed
by this source-adoption change.

Source commits are locked by Git. npm distribution versions below are explicit,
but npm artifacts are not asserted to be byte-identical to the source snapshots.
A consuming app must record its actual dependency graph in `pnpm-lock.yaml`.

## Retrieve, inspect and validate sources

```sh
node scripts/web-experience.mjs list
node scripts/web-experience.mjs fetch photoswipe embla-carousel
node scripts/web-experience.mjs fetch scroll-rig seam-transitions
node scripts/web-experience.mjs verify all --sources
node scripts/verify-web-experience-toolkit.mjs
```

Use repository-standard Node 24. The offline contract checks need no npm install.
`verify` without `--sources` checks registry, Git index pins and configured URLs;
it does not pretend that an uninitialized submodule is downloaded.
`fetch` initializes exact commits without running upstream build/install scripts.
Do not edit the source submodules in place. Updates require a reviewed change to
the gitlink, registry commit and license fingerprint together.

## PhotoSwipe 5.4.4 and Embla 8.6.0

Replace `<client-package>` with the actual workspace package name. Install only
what the client uses, and commit the resulting package and lockfile changes:

```sh
pnpm --filter '<client-package>' add '@nexus/experimental@workspace:*'
pnpm --filter '<client-package>' add --save-exact photoswipe@5.4.4 embla-carousel@8.6.0
```

Run browser-only setup in a client effect/mount hook. The following functions
return cleanup callbacks for route changes, React Strict Mode and unmounts.

```ts
import PhotoSwipeLightbox from 'photoswipe/lightbox';
import 'photoswipe/style.css';
import EmblaCarousel from 'embla-carousel';
import { mountPhotoSwipe, mountEmbla } from '@nexus/experimental/web-experience';

export function mountPortfolio(gallery: HTMLElement) {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mount = () => mountPhotoSwipe(gallery, (options) =>
    new PhotoSwipeLightbox({ ...options, pswpModule: () => import('photoswipe') }),
    motion.matches,
  );
  let stop = mount();
  const refresh = () => { stop(); stop = mount(); };
  motion.addEventListener('change', refresh);
  return () => { motion.removeEventListener('change', refresh); stop(); };
}

export function mountProjectCarousel(
  viewport: HTMLElement,
  previous: HTMLButtonElement,
  next: HTMLButtonElement,
) {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mount = () => mountEmbla(viewport, EmblaCarousel, { previous, next }, motion.matches);
  let stop = mount();
  const refresh = () => { stop(); stop = mount(); };
  motion.addEventListener('change', refresh);
  return () => { motion.removeEventListener('change', refresh); stop(); };
}
```

Gallery markup must keep real links, meaningful alternative text and actual image
width/height in `data-pswp-width` / `data-pswp-height`. Only dimensioned image links
are selected by the adapter. PhotoSwipe owns its dialog focus behavior. Confirm
focus restoration and keyboard navigation in the final application.

Embla requires a viewport, a flex track and slides. Apply client-owned layout CSS:
viewport `overflow: hidden`; track `display: flex`; slide `flex: 0 0 100%` and
`min-width: 0`. Use visible, labelled native previous/next buttons, e.g. `Anterior`
and `Siguiente`, and preserve the Core focus-visible contract. The adapter manages
button availability and cleanup; it does not invent labels, autoplay or ARIA
semantics for the site's content. Do not trap keyboard focus in the carousel.

## Scroll Rig 8.15.0

Source: `vendor/web-experience/scroll-rig/README.md`. Its npm name is
`@14islands/r3f-scroll-rig`. The source declares peers for React, React DOM, Three,
React Three Fiber and Drei. Choose compatible peer versions for the actual app;
do not silently force a React upgrade or assume React 19 compatibility has been
browser-verified here. Source package dev dependencies use React 18/R3F 8.

Keep the WebGL scene in a client-only, lazy-loaded boundary. Render a semantic DOM
image/text fallback first. Pass explicit, measured capability/preference signals
to `canUseImmersiveExperience`; disabled, reduced-motion, reduced-data or missing
WebGL must leave the fallback usable. Do not infer hardware from user-agent strings
or import these visual implementations into `@nexus/experience` or Core.

The helper is a policy gate, not a renderer or automatic capability detector.
Scroll synchronization, resize handling, canvas lifecycle and real GPU/mobile
performance still belong to the selected app integration. Do not combine two
independent smooth-scroll controllers on the same page.

## SeamTransitions — all 11 original demos

Source: `vendor/web-experience/seam-transitions/`. The pinned README documents no
build step. After fetching, run a local static server, never `file://`:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory vendor/web-experience/seam-transitions
```

Inspect `index.html`, then `index2.html` through `index11.html`. These are upstream
demos (ink, tiles, blanket, typeset, contour, marble, mist, kintsugi, roots,
sediment and wood), not eleven new stable NEXUS components. Their GSAP 3.15 plugins
and external resources remain upstream requirements. Select and adapt one effect
inside the client app with lifecycle cleanup, static fallback and reduced-motion
handling. Do not ship the complete demo collection or its external asset loading
as the client's production site. Review asset and dependency terms separately.

## Validation and promotion

The standalone contract suite covers registry shape, selection, path/URL safety,
Git pin consistency, gallery/carousel cleanup, failed-provider cleanup, disabled
button restoration and explicit immersive-policy gates. It uses provider doubles;
it is **not** a browser test of the upstream libraries.

The dedicated GitHub workflow also retrieves all four source snapshots and checks
actual checked-out commits, clean source trees and LICENSE blob identities. This
proves reproducible source acquisition, not successful rendering or a Lighthouse
score. Existing engine tests remain unchanged.

Before production use: install the selected dependencies in the actual app;
run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and the existing CI;
then test the resulting app on mobile, with keyboard, reduced motion/data,
JavaScript disabled, WebGL unavailable and repeated mount/unmount. Measure loading
and interaction performance with the actual media. Promote an adapter out of
Experimental only after this evidence exists. Do not claim full-engine validation
from the focused toolkit checks.
