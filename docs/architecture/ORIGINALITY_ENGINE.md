# Originality Engine V2

`StyleFingerprintV2` observes structure after an Experience is implemented.

It intentionally contains **no color/palette dimension**. A design that only becomes “different” after changing its palette fails the spirit of the system.

Fingerprint dimensions include:

- opening signature
- navigation signature
- section sequence
- structural metrics (card reliance, grid regularity, symmetry, overlap, whitespace, continuity)
- CTA grammar
- geometry grammar
- media grammar
- motion grammar
- typographic hierarchy

`compareFingerprints()` produces per-dimension scores and an overall similarity score. V2 does not ship a universal “too similar” threshold because the repository has insufficient evidence for one. A caller may supply an evidence-backed policy. The engine only emits an unconditional warning when there is objective exact duplication across multiple major structural dimensions.

Similarity can be justified without being erased: a justification remains attached to the report while the similarity score stays visible.
