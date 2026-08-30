# @nexus/perceptual-images

Perception-guided static image optimization using an explicit bounded candidate space. NEXUS normalizes the source with Sharp, encodes AVIF/JPEG XL candidates with native tools, decodes every candidate, renormalizes it, measures SSIMULACRA2 against the reference, and selects the smallest candidate per codec that clears both the perceptual threshold and minimum byte-savings policy.

The quality tiers preserved from the reference are `HIGH=70`, `EXCELLENT=85`, and `VISUALLY_LOSSLESS=90`. These are NEXUS policy thresholds over SSIMULACRA2 output; they do not prove mathematical/global optimality or subjective perfection.

## Native trust boundary

A usable toolchain requires `avifenc`, `avifdec`, `cjxl`, `djxl`, and `ssimulacra2`. `inspectToolchain()` records each executable's version output and SHA-256. Missing or unusable binaries produce `UNAVAILABLE`; the optimizer never substitutes a fake encoder or silently marks the capability ready.

Candidate execution is single-job/thread where the CLI supports it and bounded by hard input/candidate/time/output limits. Every candidate is decoded and normalized before measurement. A codec with no passing candidate is omitted. If neither codec passes, the result is `NO_PASSING_CANDIDATE`.

JPEG XL remains enhancement-only in generated `<picture>` markup. A root-relative fallback is mandatory, and AVIF may be supplied alongside JXL. Browser support is not inferred from successful encoding.

Operational consumer: `node scripts/audit-perceptual-images.mjs --spec <image.json>`. Exit code is `0` only for `READY`, `2` for no passing candidate, and `3` for unavailable native toolchain.

Non-claim: `SEARCH_SPACE_MINIMUM_ONLY_NOT_GLOBAL_IMAGE_OPTIMUM_OR_BROWSER_SUPPORT_PROOF`.
