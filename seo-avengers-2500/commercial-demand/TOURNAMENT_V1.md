# NEXUS Commercial Demand Tournament V1

## Purpose

This experiment turns the NEXUS organic-growth objective into a deterministic, evidence-bounded planning tournament. Its target is **15 client-equivalents per month as a planning objective**, not a forecast, promise, attribution claim, or guaranteed SEO outcome.

The tournament is intentionally conservative about evidence. It does not convert search-volume estimates into "customers", does not treat ad competition as organic ranking difficulty, and does not fill missing first-party conversion data with invented observations.

## Evidence classes

Three classes are kept separate in `nexus-commercial-demand-v1.json`:

1. **First-party observed search evidence** — the current Google Search Console window for `sc-domain:nexusbotstudio.com`.
2. **Keyword research estimates** — representative Mexico/Spanish Google Ads keyword-research rows. Search volume is demand research, not a count of unique people, not observed NEXUS traffic, and not proof that a query will rank or convert.
3. **Explicit planning assumptions** — CTR, click-to-session, and funnel rates used only to stress-test the target. They are not Google constants and are not first-party NEXUS conversion observations.

The report hashes the complete scenario. Changing observed evidence, research rows, assumptions, funnel rates, or strategies changes scenario/report identity.

## Current observed baseline

The bound Search Console snapshot is the last-30-days-with-today window captured on 2026-09-15:

- 2 clicks;
- 2,613 impressions;
- aggregate CTR 800 ppm (approximately 0.08%);
- average position 5.149;
- most surfaced query evidence is currently `web development`, with 2,365 impressions and zero clicks.

Search Console can suppress low-volume/anonymized query rows, so the query-dimension rows are not required to sum to the aggregate. The aggregate remains the window total.

## The 15-client planning target

The target is stress-tested through three explicit funnels:

- `HARD_5000`: 5,000 sessions, 2.5% lead rate, 40% qualified-lead rate, 30% close rate -> 15.000 modeled client-equivalents.
- `POOR_6250`: 6,250 sessions, 2.0% lead rate, 40% qualified-lead rate, 30% close rate -> 15.000 modeled client-equivalents.
- `VERY_POOR_11500`: the exact integer requirement is 11,429 sessions at 1.5% lead, 35% qualified, 25% close; the safety planning target is 11,500 sessions -> 15.093 modeled client-equivalents.

All funnel arithmetic is integer/BigInt math. These are bounded what-if scenarios, not predicted NEXUS performance.

## Tournament policy

Strategies are compared without a hidden weighted score. Disqualified strategies never enter the Pareto frontier. Eligible strategies are compared on five explicit dimensions:

- maximize modeled strict-commercial sessions (`DIRECT` + `DECISION` only);
- maximize modeled relevant sessions (`DIRECT` + `DECISION` + `MIXED`);
- maximize covered service-cluster breadth;
- minimize page count;
- minimize informational-session share.

A strategy dominates another only if it is no worse on every dimension and strictly better on at least one. The deterministic frontier tie-break is then:

1. strict-commercial modeled sessions, descending;
2. relevant modeled sessions, descending;
3. cluster breadth, descending;
4. page count, ascending;
5. stable strategy ID.

This ordering is a work-planning policy, not a probability of SEO success.

## Current result

With the current selected representative demand rows and explicit traffic assumptions, the compact `SERVICES_PLUS_MIXED_CORE` strategy wins the deterministic tournament. The larger 26-page concept is **not forced to win**: under the evidence currently represented, it exposes the same modeled demand and cluster breadth while requiring more pages, so the compact strategy dominates it on implementation size.

The selected strategy models approximately:

- 404.190 strict-commercial sessions/month;
- 994.590 relevant sessions/month when mixed-intent demand is included as scenario capacity.

That is far below even the 5,000-session hard target. The correct verdict is therefore:

`EXPAND_VALIDATED_DEMAND_BEFORE_CLAIM`

The experiment does **not** support a claim that the current validated seed market can generate 15 NEXUS clients/month from Mexico SEO alone. It says the opposite: the target remains an objective, but the currently represented demand must be expanded and validated before that claim can be defended.

## Execution plan that survives

The current first wave remains deliberately small and commercially focused:

- SEO commercial core;
- Web premium commercial core;
- Web Mexico decision page;
- business automation core;
- WhatsApp automation core;
- AI-for-companies core;
- custom-software core;
- pricing/quotation decision hub.

A second wave covers decision and problem-solving intent. Case/evidence pages and geography pages are allowed only when the underlying evidence or service-area facts are real and publishable. Mass city doorway generation is explicitly disqualified.

## SEO Avengers / WALLE boundary

The experiment has two different verification surfaces and they must not be conflated:

- The existing WALLE connected proof executes and verifies the native SEO Avengers M001-M2500 contract chain on the exact commit, rejects SKIP/NOT_TESTED as proof, and preserves the no-production-authority boundary.
- The NEXUS-specific scenario probe exercises the locally implemented M1001-M2500 range with the observed Search Console rows plus probe-only descriptions of already-known NEXUS service categories. It intentionally leaves CRM funnel, local-business, canonical, history, competitor-coverage, and other unavailable first-party datasets empty. Missing evidence must therefore surface as `INSUFFICIENT_DATA`/blocking evidence rather than being fabricated.

The scenario probe does not claim that M001-M1000 consumed one unified NEXUS payload. Those delegated modules remain covered by their native WALLE execution proof, while the NEXUS-specific local probe covers M1001-M2500.

## Operational boundary

Nothing in this tournament authorizes or performs:

- production deployment;
- Vercel changes;
- DNS changes;
- site/CMS mutation;
- Ads mutation;
- tenant activation;
- external-link creation;
- fake reviews or fake locations;
- doorway-page generation.

The output is a deterministic planning artifact and a falsifiable evidence gate. Production execution requires a separate explicit authorization and live measurement plan.
