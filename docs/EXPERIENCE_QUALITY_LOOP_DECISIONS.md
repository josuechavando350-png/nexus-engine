# NEXUS Experience Quality Loop — implementation decisions

This document records explicit decisions for the next NEXUS quality phase. It exists to prevent silent scope changes.

## Adopted now

- Mobile-first creative judgment at 390px.
- NEXUS core remains aesthetic-agnostic.
- No invented creative quality scores. Runtime verdict states are PASS / FAIL / WARNING / NOT_TESTED.
- Creative judgment must be brand-DNA-relative, not a generic beauty score.
- Any component that claims to measure must have a real adapter before it can report PASS.
- Reference sources are metadata/provenance/principle inputs only; third-party assets and paid prompt text are not mirrored.
- The external inspiration layer and the internal originality corpus are different systems: the latter is built from NEXUS-delivered fingerprints.

## Proposed implementation sequence after disputed items are resolved

1. Preserve and test the existing ExperienceDNA contract; document field-to-output influence.
2. Deterministic DNA -> token/CSS emitter.
3. Real browser capture adapter (Playwright) with 390/768/1440 artifacts.
4. Multimodal visual judge using explicit PASS/FAIL/WARNING/NOT_TESTED findings.
5. Human calibration dataset and correlation reporting.
6. Bounded automatic repair loop (max 3 iterations per scene).
7. Versioned StyleFingerprintV2 corpus and similarity block.
8. Opening-scene creative tournament.
9. Design Genome extraction from approved reference implementations without copying their surface aesthetic.
10. Production evidence and periodic re-evaluation.

## Disputed items requiring owner decision before destructive implementation

### A. Moving `runtime/` to another repository

Current NEXUS CI, SBOM, Cargo policy checks, architecture gates, and clean-room evidence are integrated across the monorepo. Removing `runtime/` now would introduce a second repository boundary, cross-repository provenance, dependency pinning, release coordination, and reproducibility work before it provides creative quality value.

Recommendation: keep `runtime/` in this repository during the quality-loop phase. Re-evaluate extraction only after a stable versioned API boundary and cross-repository signed provenance are implemented.

### B. Blanket typography-source rules

Quality must be enforced through typography behavior (optical sizing, subsetting, CLS controls, licensing/provenance, DNA fit), not by assuming a font is bad because of its distributor. Premium licensed type is strongly preferred when the brand warrants it, but distributor alone is not a quality signal.

### C. Claims of guaranteed aesthetic score

NEXUS can guarantee that required checks ran and that weak outputs are blocked according to calibrated gates. It cannot truthfully guarantee a universal human aesthetic score. Product claims should be evidence-based: no approval without calibrated visual review, brand-DNA coherence, originality checks, mobile evidence, accessibility/performance evidence, and bounded repair attempts.
