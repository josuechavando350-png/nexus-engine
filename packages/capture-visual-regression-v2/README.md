# @nexus/capture-visual-regression-v2

Reusable, evidence-bound visual-regression contract for NEXUS. It formalizes a scene, exact rendering environment, explicitly approved masks, exact screenshot bytes, an explicitly approved baseline, pixel diff and a SSIMULACRA2 perceptual gate.

A baseline is never promoted because a pull request changed. `approveBaseline()` requires an explicit `approvalReference`; the reference is provenance supplied by the operator and is not itself cryptographic proof that a human approved the image. Production processes must preserve the real approval record behind that reference. Intentional visual changes therefore fail first, then require explicit art-direction review and a separate baseline promotion operation.

`captureScene()` runs Chromium or WebKit headlessly with device scale factor 1, UTC, `en-US`, reduced motion, light color scheme, fonts ready, images decoded, disabled animation/transition styling, disabled screenshot animations, hidden caret and CSS screenshot scaling. The capture record binds scene digest, revision, build digest, browser + Playwright environment, viewport, screenshot SHA-256 and mask observations.

Masks require a non-empty reason and approval reference. Universal/root/body/main selectors and selectors containing `*` are rejected. Mask count and total area are bounded during capture; comparison rejects selector/count drift and excessive area drift so a stable selector cannot silently grow to hide a regression.

`compareCapture()` validates the baseline and capture digests, then re-hashes both PNG files before any verdict. Rendering-environment or viewport mismatch produces `INCOMPATIBLE_BASELINE`, never a fake design failure. Dimension mismatch, mask drift, pixel regression and perceptual regression are explicit failures. Diff PNG bytes are SHA-256-bound to the comparison report.

The perceptual adapter uses the shared SSIMULACRA2 parser from `@nexus/perceptual-images`, linking capability #9 to #10 rather than duplicating the metric parser. Missing native tooling must remain unavailable; no synthetic comparator is used by production defaults.

Operational consumer: `node scripts/audit-visual-regression-v2.mjs --spec <visual-regression.json>`. Without an approved baseline it emits `CAPTURED_ONLY`; it never treats a fresh capture as an approved baseline automatically. With a baseline, a real `ssimulacra2Path` is mandatory.

Non-claim: `VISUAL_REGRESSION_EXECUTION_NOT_AUTOMATIC_ART_DIRECTION_APPROVAL`. The motor executes and compares; art direction determines whether an intentional change should become a new approved baseline.
