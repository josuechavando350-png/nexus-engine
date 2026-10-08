# RMC-017 — Final Real Market Census Closeout Contract

RMC-017 is the sole authority allowed to emit `REAL_MARKET_CENSUS_CLOSED`.

It requires three independently authenticated authority families:

1. RMC-014 structural chain authority;
2. RMC-015 temporal opportunity authority;
3. RMC-016 conservative realizable capacity authority.

No snapshot-only, synthetic, mutable-latest, inferred or partially covered evidence
may satisfy final closeout.

Final admission requires, for all three authorities:

- exact code commit/tree;
- exact canonical workflow/run/artifact identity;
- immutable artifact digest;
- admitted=true;
- coverage_complete=true;
- unresolved_mismatch_count=0;
- unknown_failure_count=0;
- blocker_count=0;
- non-empty content-addressed evidence.

Additionally:

- RMC-014 must report structural_chain_certified=true and real_market_census_closed=false;
- RMC-015 must prove complete temporal conservation, no look-ahead and zero material UNKNOWN;
- RMC-016 must report conservative_realizable_capacity_only=true,
  global_market_maximum_claimed=false and no unsupported capture-adjusted capacity claim.

RMC-017 does not prove realized profitability or the Month-1 target. Those remain
Shadow/Canary/real-P&L claims.

The **offline** `rmc017_closeout_model.validate` helper is foundation-only: even with syntactically valid, artificially constructed authority rows, it MUST emit `RMC017_FOUNDATION_CANDIDATE_VALID_NOT_CERTIFIED`, `terminal_authority=false`, `independent_artifact_authentication_complete=false` and `real_market_census_closed=false`. Synthetic tests and green CI MUST NOT produce a final Census marker. A separate production terminal workflow must independently reauthenticate exact D14/D15/D16 GitHub run metadata, archive bytes and inner semantic evidence before any final claim.

The source lock can never self-certify closure. Only a deterministic final
certificate generated from pinned, independently reauthenticated artifacts may set:

`real_market_census_closed=true`

and emit:

`REAL_MARKET_CENSUS_CLOSED`.
