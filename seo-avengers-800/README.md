# SEO Avengers 800 — semantic Bayesian slice

This package is the in-progress M601-M800 extension. It does **not** claim the full
800 composition is complete yet.

Current production implementation in this slice:

- Existing M001-M600 remain delegated to the already-audited `seo-avengers-600` runtime.
- Source M1701-M1725 map exactly to runtime M701-M725.
- The 25 M701-M725 modules are executable deterministic evidence algorithms.
- No M601-M700 or M726-M800 module is promoted by this slice.
- Missing evidence returns `INSUFFICIENT_DATA`; malformed/conflicting evidence returns `ERROR`.
- Floats are rejected by the shared normalization contract; output-affecting config is hash-bound.
- All thresholds and metrics use integer PPM in the range 0..1,000,000.
- Shannon entropy uses integer-only Q24 binary logarithm approximation and is normalized to PPM.
- There are no external provider side effects and no synthesized Ads, traffic, authority, or competitor data.
- Activation remains `deny_by_default`.
- `apps/cano-penal` and `delivery/cano-penal` are outside this package and must not be touched.

The source blueprint's generic M1706-M1725 resolver loop was hardened into 20
operation-specific evidence contracts instead of cloning one algorithm under different IDs.
