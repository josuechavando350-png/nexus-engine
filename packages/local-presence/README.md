# @nexus/local-presence

Canonical multi-location NAP, provider drift detection, explicit Google Business Profile write plans, caller-approved review replies, and factual LocalBusiness JSON-LD.

The package is fail-closed: missing OAuth or provider identifiers are `UNAVAILABLE`; provider/shape failures are `FAIL`; writes require explicit caller approval and an exact replay of the current live-attested provider snapshot. A SHA-256 digest is deterministic identity, not proof that data came from Google; live provider authority is process-local and issued only by the real Business Profile adapter.

Google Business Profile location facts use the Business Information API (`mybusinessbusinessinformation.googleapis.com/v1/locations/{id}` with `readMask` / `PATCH` + `updateMask`). Reviews and replies use the Google My Business v4 review endpoints. OAuth credentials are supplied externally and are never stored here.

`localBusinessJsonLd()` emits only factual business/address fields from the canonical location. It deliberately does not manufacture `AggregateRating`, `Review`, `reviewCount`, authors, or ratings. Displaying real reviews and eligibility for Google review rich results are separate concerns.

`scripts/audit-local-presence.mjs` is the operational consumer: it reads a canonical location, fetches live GBP facts when credentials are available, reports drift, emits an explicit sync plan, optionally fetches reviews, and outputs factual JSON-LD. It never performs a write by default.
