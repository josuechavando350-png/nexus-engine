# NEXUS Commercial Demand Tournament V8

## Purpose

V8 turns the V7 observability blocker into a concrete evidence contract. It does **not** install tracking. It defines exactly what future first-party evidence must look like before NEXUS can responsibly estimate conversion performance or support a 15-client/month floor claim.

The core question is no longer "can we make a number above 15 appear in a spreadsheet?" It is: **what observed data would be sufficient to distinguish a real conversion rate from planning assumptions without double-counting clients, changing qualification rules, or mixing cohorts?**

## Certified baseline

V8 chains through V7 and fails closed unless the prior chain still reports:

- V7 verdict `OBSERVED_FUNNEL_REQUIRED_BEFORE_15_CLIENT_FLOOR_CLAIM`.
- probability of at least 15 clients/month `NOT_IDENTIFIABLE_FROM_AVAILABLE_EVIDENCE`.
- V6 optimistic zero-overlap combined envelope: 1,147.44 sessions/month.
- session-to-client rate required for 15 clients at that envelope: 1.3073%.

V8 does not alter the 40-page organic architecture, keyword universe, paid-search forecast, or acquisition envelope.

## First-party event contract

The future evidence chain is explicitly four-stage:

| Event | Count unit | Required join purpose |
| --- | --- | --- |
| `SESSION` | unique session ID | denominator + acquisition source |
| `CONTACT` | unique lead ID | visit-to-contact conversion |
| `QUALIFIED_LEAD` | unique lead ID under versioned qualification policy | lead quality |
| `CLOSED_CLIENT` | unique new-client ID hash | actual new-client outcome |

A close is not counted merely because a `CLOSED_CLIENT` event exists. The counting rule is:

`COUNT_DISTINCT_NEW_CLIENT_ID_HASH_WHERE_IS_NEW_CLIENT_TRUE`

Repeat purchases, expansions, renewals, or duplicate close events must not inflate the new-client count.

Qualification must retain its policy version. The system is not allowed to rewrite qualification criteria retroactively just to improve the funnel.

## Attribution and cohort rules

The contract preserves raw source, medium, campaign, and landing page before any normalized channel mapping.

Every downstream event must join back through the declared cohort:

- contact requires a session;
- qualified lead requires a contact;
- closed client requires a qualified lead;
- session denominator and downstream outcomes must belong to the same declared cohort.

A cohort cannot be declared mature until observed close-lag evidence supports the cutoff. V8 intentionally does **not** invent a seven-day, 30-day, or 90-day maturation window.

## Privacy boundary

The analytics contract does not require raw phone numbers, raw email addresses, or message bodies.

For client deduplication, analysis requires only a stable pseudonymous client hash. That is sufficient to avoid counting the same customer twice without requiring raw contact PII in the evidence layer.

## Prospective statistical gate

V8 defines a 95% Wilson-score lower-bound gate for the session-to-new-client rate.

Target conversion rate: **1.3073%**, inherited from the certified V6 break-even requirement. This is not an observed NEXUS rate.

The checkpoint sizes are multiples of the ceiling of the V6 combined envelope: 1,148 sessions.

| Fully matured observed sessions | Minimum unique new closed clients | Observed rate at threshold | 95% Wilson lower bound |
| ---: | ---: | ---: | ---: |
| 1,148 | 23 | 2.0035% | 1.3386% |
| 2,296 | 41 | 1.7857% | 1.3190% |
| 4,592 | 76 | 1.6551% | 1.3244% |
| 9,184 | 142 | 1.5462% | 1.3133% |

For every row, one fewer client leaves the lower bound below the 1.3073% target.

This does **not** mean NEXUS needs exactly those session counts or that those outcomes will occur. These are prospective evidence checkpoints: if a fully matured real cohort has that denominator and at least that many unique new clients, the conversion-rate lower bound clears the V6 break-even rate under the stated statistical method.

## What V8 still cannot prove

V8 does not prove:

- that the V6 traffic envelope will be achieved;
- that paid traffic is fully incremental to organic traffic;
- that the current site converts at 1.3073% or any other rate;
- that 15 clients will occur in a given month;
- a probability of reaching 15+ clients/month.

The last point remains especially important. A monthly client-count probability requires real observed traffic and conversion distributions, not just a conversion-rate confidence interval.

## Result

V8 verdict:

`MEASUREMENT_CONTRACT_READY_OBSERVED_COHORTS_STILL_REQUIRED`

What changed from V7:

- V7 proved the first-party funnel evidence was missing.
- V8 defines exactly how that evidence must be counted, joined, deduplicated, attributed, matured, and statistically evaluated.
- The remaining blocker is no longer ambiguity about what to measure. It is the absence of real matured cohorts produced by an installed measurement system.

Decision boundary:

`PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_OR_TENANT_MUTATION`
