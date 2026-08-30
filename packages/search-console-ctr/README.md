# @nexus/search-console-ctr

CTR engineering from first-party Google Search Console Search Analytics data.

The package does not claim complete query coverage: the Search Analytics API explicitly does not guarantee all rows and returns top data within Search Console limits. Every dataset therefore carries `TOP_ROWS_NOT_GUARANTEED_COMPLETE`.

`buildMonotonicCtrCurve()` fits an impression-weighted PAVA curve whose expected CTR is non-increasing as average position worsens. `analyzeCtrOpportunities()` compares observed CTR with that site-specific curve and estimates click opportunity. These are internal diagnostics, not Google ranking metrics and not causal claims.

A zero observed CTR produces `relativeCtrDelta: null`, never Infinity.

`fetchSearchAnalytics()` calls the official Search Analytics query endpoint with OAuth bearer authentication. Missing credentials return `UNAVAILABLE`; provider errors or malformed payloads return `FAIL`. No synthetic response is promoted to first-party authority.
