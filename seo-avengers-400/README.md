# SEO Avengers 400

This package is the exact 400-module composition requested for the current delivery checkpoint.

- **M001-M200** remain the original production `seo-avengers-200` sidecar. They are delegated, not copied or replaced here.
- **M201-M400** are the 200 new source-bound algorithms from the supplied M1201-M1400 blueprint, remapped sequentially and exclusively into M201-M400.
- There is no M401 entry in this suite.
- The new algorithms consume only explicit evidence arrays. Missing evidence returns `INSUFFICIENT_DATA`; malformed input, floats, conflicting duplicates, or invalid configuration fail closed.
- Every new receipt binds raw input, normalized input, module configuration, algorithm identity, source blueprint identity, and evidence hash.

Source blueprint SHA-256: `sha256:16dc5dd3c0834c1e3306add2bb79b00aac072fd5767ce352c31725d2d024e9d1`.

The composition runtime is deny-by-default and activates only when `CONFIG_SEO_AVENGERS_400` is exactly `true`. It never fabricates receipts for M001-M200; those remain owned by the existing original sidecar.
