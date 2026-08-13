# ADR 0006 — Originality fingerprints exclude color

## Decision

`StyleFingerprintV2` has no palette/color dimension.

## Why

Color is too easy to change while preserving the same template. Structural originality must be evaluated in a way that survives a grayscale or brand-stripped comparison.
