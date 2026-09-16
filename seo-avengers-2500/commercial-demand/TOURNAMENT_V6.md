# NEXUS Commercial Demand Tournament V6

## Purpose

V6 stops treating the next step as "make more pages" and tests a different acquisition lever: **paid search on the existing, offer-aligned commercial portfolio**.

The 15-client objective remains a planning floor only. V6 does not claim probability of success, expected traffic, expected leads, expected clients or expected revenue. It does not launch campaigns or mutate production.

## Certified baseline

V6 chains through V5 and fails closed unless V5 still selects:

`OFFER_FIT_FULL_VALIDATED_40`

with:

- 40 explicit organic pages.
- 11,750 validated representative relevant searches/month.
- 776.70 modeled relevant organic sessions/month.
- V5 verdict still requiring more demand and/or channels before any 15-client floor claim.

## Fresh paid-search research

A current-offer-aligned exact-match planning portfolio of 17 keywords was measured with Google Ads planning data for Mexico / Spanish.

Known-keyword metrics result:

`c56bf255-fe7c-46f1-9f6d-91896c6fd392`

The paid-traffic forecast was then measured at three exact-match bid points for next month:

| Bid | Forecast clicks | Forecast cost | Avg CPC | Result ID |
| ---: | ---: | ---: | ---: | --- |
| $2.00 | 229.57 | $260.79 | $1.14 | `36165dc8-5410-4033-a884-d663c34b3285` |
| $4.00 | 347.33 | $655.26 | $1.89 | `ebbc56eb-7c05-4a7f-a65e-737b497653dc` |
| $8.00 | 370.74 | $926.96 | $2.50 | `eeb14390-1634-4971-9f88-1abc9ffeb66b` |

All monetary figures are planner estimates in USD. They are not actual spend.

## Exact-match channel frontier

The largest exact-match capture envelope is the $8 bid point at 370.74 forecast clicks.

V6 deliberately does **not** call those 370.74 clicks incremental sessions. Paid-organic overlap is not observed and GA4 conversion evidence is unavailable. Instead, V6 computes a deliberately optimistic **zero-overlap upper bound**:

- Organic modeled sessions: 776.70.
- Paid exact-match forecast clicks: 370.74.
- Zero-overlap upper-bound combined sessions: 1,147.44.

Using the existing hypothetical high-conversion sensitivity of 0.77% session-to-client:

- Upper-bound modeled clients: 8.835.
- Planning floor: 15.
- Gap: 6.165 clients.

Again, 8.835 is not an expected outcome. It is a sensitivity calculation on top of an optimistic zero-overlap channel envelope.

To produce 15 clients from 1,147.44 sessions would require a session-to-client rate of at least **1.3073%**. For 16 clients it would require **1.3945%**. Those are requirements, not forecasts.

## Phrase/broad anti-inflation control

At a $4 bid, planner forecasts were also collected for expanded match types:

| Match | Forecast clicks | Forecast cost | Raw high-conversion sensitivity with organic |
| --- | ---: | ---: | ---: |
| phrase | 1,240.30 | $1,966.18 | 15.530 modeled clients |
| broad | 1,141.36 | $2,163.53 | 14.769 modeled clients |

The phrase row is intentionally important: if V6 naively treated all planner clicks as equally qualified and additive, it could manufacture a result above 15.

V6 **rejects that false pass**. Phrase and broad forecasts are ineligible for floor support until query-level search-term evidence proves intent and offer fit, and until incrementality plus conversion are observed. The system must not get to 15 by widening match type and pretending all extra clicks are equivalent buyers.

## Result

V6 verdict:

`MULTI_CHANNEL_AND_OBSERVED_FUNNEL_EVIDENCE_REQUIRED_BEFORE_FLOOR_CLAIM`

What this means:

- More organic pages alone had already reached diminishing returns in V5.
- Exact paid search adds meaningful capture capacity, but does not close the 15-client gap under the current planning assumptions.
- Expanded paid match can superficially cross the target, but the evidence quality is insufficient and is therefore rejected.
- The next useful frontier is additional validated channels and, critically, first-party funnel measurement so hypothetical conversion can be replaced with observed conversion.

Decision boundary:

`PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_OR_TENANT_MUTATION`
