# NEXUS Commercial Demand Tournament V2

Tournament V2 re-runs the commercial strategy competition with a stricter evidence model than V1.

## Objective

The commercial objective is a **minimum planning floor of 15 new clients per month**. It is not a forecast, guarantee, or promise. The tournament maximizes the worst-case modeled client capacity across the configured stress funnels and then uses strict commercial demand, relevant demand, semantic-family coverage, and fewer pages as deterministic tie-breakers.

## Why V2 exists

V1 correctly selected `SERVICES_PLUS_MIXED_CORE`, but it had two weaknesses that V2 closes:

- the selected strategy declared 18 pages while the execution plan named only 16 concrete pages;
- representative keyword rows could overlap semantically, so summing their research volumes could overstate addressable demand.

V2 removes declared page counts entirely. A strategy's page count is derived from its explicit `pageIds`. It also groups search variants into semantic demand families and counts one conservative representative volume per family.

## Evidence snapshot

- First-party baseline is carried forward unchanged from the V1 Search Console capture of 2026-09-15. It is context only and never becomes a funnel.
- Keyword research was refreshed on 2026-09-16 with Google Ads keyword research via HYPD for Mexico / Spanish.
- The refreshed result set contained 2,291 candidate rows.
- The scenario curates 26 semantic demand families. Spelling variants, close synonyms, free/DIY queries, competitor brands, industrial automation, irrelevant queries, and generic informational volume are not silently added to commercial demand.
- CTR, click-to-session, and funnel rates remain explicit planning assumptions.

## Strategies

| Strategy | Pages | Unique demand families | Relevant modeled sessions / month | Worst stress modeled clients | Eligible |
| --- | ---: | ---: | ---: | ---: | --- |
| `LEAN_STRICT_COMMERCIAL_12` | 12 | 12 | 306.99 | 0.402 | yes |
| `SERVICES_PLUS_MIXED_CORE_RECONCILED_18` | 18 | 18 | 590.40 | 0.774 | yes |
| `EVIDENCE_WEIGHTED_HYBRID_26` | 26 | 25 | 633.87 | 0.831 | yes |
| `EXPANDED_PROBLEM_DECISION_32` | 32 | 25 | 633.87 | 0.831 | yes |
| `INFORMATIONAL_VOLUME_MAXIMIZER_33` | 33 | 26 | 633.87 relevant + 217.80 informational | 0.831 | no |

## Deterministic winner

`EVIDENCE_WEIGHTED_HYBRID_26`

Why it wins:

- it covers more evidence-backed demand families than the reconciled 18-page strategy;
- it has higher strict-commercial and relevant modeled capacity than the 18-page strategy;
- the 32-page strategy adds decision/problem pages but no new unique demand families, so it does not inflate demand and loses on page efficiency;
- the informational-volume strategy is ineligible before ranking.

The winner has 26 explicit pages. There is no 18-vs-16 ambiguity in V2.

## 15-client floor result

The current evidence does **not** support a claim that the winner can deliver 15 clients per month.

With the current planning assumptions, the 26-page winner models:

- HARD funnel: 1.901 clients / month
- POOR funnel: 1.521 clients / month
- VERY_POOR funnel: 0.831 clients / month

Verdict:

`EXPAND_VALIDATED_DEMAND_AND_OR_CHANNELS_BEFORE_FLOOR_CLAIM`

This is intentionally fail-closed. The tournament does not manufacture enough demand to make the 15-client floor pass.

## Research ceiling

V2 also calculates an intentionally unrealistic upper bound: 100% click capture of every curated relevant search-family query, followed by the 90% click-to-session planning assumption.

That ceiling is 8,595 sessions / month from 9,550 deduplicated relevant monthly searches. Under the same funnels it models:

- HARD: 25.785 clients
- POOR: 20.628 clients
- VERY_POOR: 11.280 clients

Even this impossible 100% search-click-capture upper bound does not support the 15-client floor in the VERY_POOR stress case. This is strong evidence that a defensible >15-client planning floor cannot come from the current organic-search seed alone under all configured stress assumptions. More validated demand, additional acquisition channels, better observed funnel performance, or a combination is required before that claim can strengthen.

## Safety and production boundary

Tournament V2 is plan-only. It does not mutate the website, CMS, Ads, DNS, Vercel, tenants, or production. No SKIP, NOT_TESTED, INSUFFICIENT_DATA, informational traffic, synonym inflation, or unverified location pages may be converted into commercial success.
