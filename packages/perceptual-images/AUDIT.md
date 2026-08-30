# Perceptual Images audit

Status: integration in progress; exact-head CI and native-toolchain proof required before merge.

## Capability 9/20

Implements `@nexus/perceptual-images` from the consolidated reference: bounded AVIF/JPEG XL candidate search, decode-and-renormalize verification, SSIMULACRA2 thresholding, minimum byte savings, smallest-passing selection and safe `<picture>` output.

## Preserved contract

- Sharp normalizes orientation/color/metadata into a deterministic PNG reference.
- AVIF and JPEG XL candidates are explicitly enumerated; no hidden quality search.
- Every encoded candidate is decoded before SSIMULACRA2 measurement.
- Quality tiers: HIGH 70, EXCELLENT 85, VISUALLY_LOSSLESS 90.
- Selection is the smallest passing candidate per codec inside the declared search space only.
- JPEG XL is enhancement-only; fallback remains mandatory.

## Hardening

- hard candidate/input/timeout/stdout bounds;
- strict policy validation and deterministic ordering;
- native toolchain inspection with executable SHA-256/version evidence;
- fail-closed `UNAVAILABLE` for missing/unusable native tools;
- fail-closed `NO_PASSING_CANDIDATE` when quality/savings policy is not met;
- source/candidate/report digests;
- root-relative asset URLs and HTML escaping;
- injected command runner exists only as a testability boundary; production defaults to real `execFile` binaries;
- no claim of global mathematical optimum or browser-support proof.

## External revalidation

Current SSIMULACRA2 documentation still defines a full-reference score up to 100 and libjxl ships the `ssimulacra2` tool. libjxl remains the reference implementation for `cjxl`/`djxl`; libavif provides `avifenc`/`avifdec`. CLI availability/version must be demonstrated in CI rather than assumed.

## Acceptance

Before merge: package typecheck/tests/build, repository lint, a native CI smoke with real `avifenc`/`avifdec`/`cjxl`/`djxl`/`ssimulacra2`, operational-consumer exercise, final diff audit, and all four exact-head NEXUS workflows green.
