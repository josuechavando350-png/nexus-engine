# RMC-017 — Final Real Market Census Authority

RMC-017 is the only stage allowed to emit `REAL_MARKET_CENSUS_CLOSED`.

It is a pure closeout authority. It has no signing, broadcast, trading, RPC
discovery, route selection, capture-probability or P&L authority.

Final closure requires three independently authenticated immutable authorities:

1. RMC-014 structural chain certification for RMC-006..RMC-013;
2. RMC-015 temporal opportunity authority over the declared historical window;
3. RMC-016 conservative, conflict-aware capacity authority.

Every pinned authority must bind an exact successful GitHub workflow run,
workflow name, head commit, tree, artifact id, artifact name and artifact
digest. The downloaded package must reproduce its own checksums.

RMC-017 must fail closed if any authority has unresolved mismatch, material
UNKNOWN, blocker, look-ahead, double counting, optimistic extrapolation, or an
attempt to convert uncalibrated capture into realized P&L.

A zero conservative capacity lower bound is legal. Census certifies market and
execution truth; it does not self-certify Shadow capture, Canary results,
realized P&L, or Revenue Reliability.

The Month-1 USD 300,000 objective remains a falsifiable downstream target and
is never a premise of RMC-017.

A successful terminal run emits:

`REAL_MARKET_CENSUS_CLOSED`

and an immutable `rmc017-final-census-certificate.json` with
`real_market_census_closed=true`.
