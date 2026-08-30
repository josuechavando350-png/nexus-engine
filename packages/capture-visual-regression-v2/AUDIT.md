# Visual Regression V2 audit

Status: implementation complete; native Chromium + real SSIMULACRA2 proof passed before PR, and merge remains gated on the four required exact-head workflows plus this final diff audit.

## Capability 10/26

Implements the consolidated `@nexus/capture-visual-regression-v2` reference as a reusable contract rather than replacing NEXUS art direction with an automatic baseline updater.

## Preserved source contract

- Visual scene = URL + full-page policy + explicitly justified masks + pixel/perceptual thresholds.
- Chromium/WebKit capture uses a controlled rendering environment.
- Baselines bind the scene and rendering environment and require an explicit approval reference.
- Pixelmatch provides exact changed-pixel count/ratio.
- SSIMULACRA2 is the second perceptual comparator.
- `PASS`, `FAIL`, and `INCOMPATIBLE_BASELINE` are distinct states.
- Browser/rendering-environment changes invalidate a baseline instead of masquerading as a design regression.
- Mask match-count drift is a failure.
- Intentional design changes fail first; promotion is a separate human-governed operation.

## Hardening beyond the reference

- strict HTTP(S) scene URL validation and credential rejection;
- hard scene/mask/match/viewport/navigation/tool-output bounds;
- universal/root/body/main and wildcard mask selectors rejected;
- mask reason and approval provenance mandatory;
- rendering environment is computed from the actual browser/Playwright/runtime configuration rather than caller-declared as trusted text;
- capture bytes are SHA-256-bound to a replay-verifiable capture record;
- approved baseline binds original capture digest, build digest, environment, viewport, screenshot hash and mask observations;
- comparison re-hashes baseline/current image bytes before verdict;
- viewport and full rendering environment mismatch are incompatible baseline states;
- mask area drift is checked in addition to selector/count drift;
- diff artifact SHA-256 is bound into the comparison digest;
- SSIMULACRA2 parsing is reused from capability #9 instead of forked;
- no auto-promotion API exists in the operational CI consumer.

## Existing pipeline reconciliation

NEXUS already has a basic base-vs-head ImageMagick visual gate in `quality-browser-capture.yml` / `scripts/ci-browser-quality.mjs`. That relative-diff gate is useful but is not an explicitly human-approved V2 baseline. This capability does not relabel that ephemeral base revision as approved evidence. V2 is the reusable approved-baseline layer while the legacy relative gate remains until committed/project-specific approved baseline manifests are deliberately introduced.

## Acceptance

Observed before this final documentation-only audit commit: package typecheck/tests/build/lint, native Chromium capture, real SSIMULACRA2 comparison, operational-consumer smoke, lockfile synchronization, and all four required workflows passed on the preceding exact head. Because this audit correction changes the head SHA, the four workflows must pass again on the final head before merge. Synthetic native smoke approval references are test fixtures only and must never be represented as production art-direction approval.
