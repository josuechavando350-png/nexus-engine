# SEO Avengers 800 — in-progress M601-M800 batch

This package is the active extension from the merged 600-module composition toward exactly 800 Avengers.

Current audited implementation on this branch:

- Existing M001-M600 remain delegated to the already-audited `seo-avengers-600` runtime.
- Source M1701-M1725 map exactly to runtime M701-M725.
- Source M1726-M1750 map exactly to runtime M726-M750.
- M701-M750 are 50 executable deterministic evidence algorithms.
- M601-M700 and M751-M800 are still pending and are **not** promoted or counted as implemented yet.
- Missing evidence returns `INSUFFICIENT_DATA`; malformed/conflicting evidence returns `ERROR`.
- Floats are rejected by the shared normalization contract; output-affecting config is hash-bound.
- All thresholds and metrics use integer PPM in the range 0..1,000,000.
- Shannon entropy uses integer-only fixed-point binary logarithm approximation and is normalized to PPM.
- HTML/streaming modules audit symmetric document/protocol evidence only; they do not produce crawler-specific content.
- There are no external provider side effects and no synthesized Ads, traffic, authority, or competitor data.
- Activation remains `deny_by_default`.
- Client application and delivery paths are outside this package and are not modified by this branch.

The source blueprint's generic resolver/flattening loops are hardened into operation-specific evidence contracts instead of cloning one algorithm under different IDs.

The PR remains draft until the complete M601-M800 batch is implemented, audited, and all exact-head repository CI is green.
