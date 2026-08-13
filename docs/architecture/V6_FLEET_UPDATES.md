# V6 Fleet Management and Signed Updates

Fleet state is explicit: Enrolled, Healthy, Degraded, Quarantined, Draining, Retired.

Rollouts are staged by ring: Canary -> Early -> Stable -> Critical. A rollout specifies max parallelism, minimum healthy percentage, exclusions and halt-on-failure behavior.

A software release is not deployable from a URL alone. The update path requires a versioned manifest with artifact digest, SBOM digest, provenance digest, expiry and rollback floor. Verification must precede staging.

TUF and Sigstore/cosign are candidate mechanisms. NEXUS owns rollout and anti-rollback semantics; signing infrastructure remains replaceable.
