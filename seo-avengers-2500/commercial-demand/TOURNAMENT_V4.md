# NEXUS Commercial Demand Tournament V4

## Purpose

V4 extends the certified V3 commercial-demand tournament with a new software-buyer research frontier. The objective remains a **minimum planning floor of 15 new clients per month**, not a promise, probability, forecast, ranking guarantee, traffic guarantee, lead guarantee or revenue guarantee.

V4 does not mutate production. It does not deploy pages, change Vercel, DNS, Ads, CMS, tenants or any external client property.

## Certified baseline

V4 chains through the V3 engine before evaluating any new strategy. V3 must still select:

`SERVICE_FRONTIER_FULL_VALIDATED_32`

with 32 explicit page IDs and the same evidence-bound report. If that certified V3 baseline drifts, V4 fails closed.

## Fresh research

Two separate Google Ads research artifacts are intentionally kept distinct:

- Discovery result `49208b09-f11e-4031-8fca-03b1ed756d85`: 723 candidate rows reviewed from software, automation, chatbot, web and SEO buyer-language seeds. These rows are discovery candidates only. They are **not unique people, not unique demand, and are never summed into commercial capacity**.
- Exact known-keyword result `ea1854ca-8880-4bf7-ba54-29708bcc0928`: five representative software terms with bound Mexico / Spanish search-volume estimates used for the incremental V4 families.

The exact snapshot is:

| Family | Representative keyword | Intent | Monthly research volume | Competition index |
| --- | --- | --- | ---: | ---: |
| `SOFTWARE_COMPANY_GENERIC` | `empresa de software` | MIXED | 1,000 | 18 |
| `SOFTWARE_DEVELOPMENT_COMPANY` | `empresas de desarrollo de software` | DECISION | 480 | 49 |
| `SOFTWARE_CONSULTING` | `consultoria de software` | MIXED | 170 | 53 |
| `SOFTWARE_FACTORY` | `fabrica de software` | MIXED | 140 | 41 |
| `SOFTWARE_DEVELOPMENT_GENERIC_INFO` | `desarrollo de software` | INFORMATIONAL | 5,400 | 36 |

The public first-party NEXUS offer snapshot already exposes `Plataformas a medida` and `Estrategia y Consultoría`, so these families are relevant to services NEXUS actually offers. Offer presence does not prove demand or conversion.

## SERP intent checks

V4 binds a separate Mexico / Spanish SERP result to each relevant family:

- `empresa de software` → MIXED. Provider/local-business results coexist with rankings, category, recruiting and explanatory results.
- `empresas de desarrollo de software` → DECISION. Paid custom-software offers, provider pages, local businesses and vendor-comparison results create a strong buyer-decision signal without proving a transaction.
- `consultoria de software` → MIXED. Service providers coexist with jobs, definitions and discussion results.
- `fabrica de software` → MIXED. Software-factory businesses and service pages coexist with definitions, government, academic and explanatory content.

`desarrollo de software` is an explicit **INFORMATIONAL guard**. Its 5,400 monthly research volume is not counted as commercial capacity because the observed SERP is dominated by definitions, education, lifecycle material, courses/careers and explanatory pages.

## Conservative deduplication

Semantic variants are absorbed into one representative family rather than summed as separate buyers. Examples:

- `empresa de software` absorbs `empresas de software`.
- `empresas de desarrollo de software` absorbs singular/word-order variants.
- `consultoria de software` absorbs accented/plural variants.
- `fabrica de software` absorbs the accented spelling.

This preserves the V2/V3 rule: **one conservative representative volume per semantic demand family**.

## Strategies

V4 makes the certified 32-page V3 winner compete against four explicit alternatives:

| Strategy | Pages | What changes |
| --- | ---: | --- |
| `V3_SERVICE_FRONTIER_BASELINE_32` | 32 | Certified V3 winner preserved as control |
| `SOFTWARE_BUYER_FRONTIER_CORE_34` | 34 | Adds software-company and development-company buyer families |
| `SOFTWARE_BUYER_FRONTIER_FULL_VALIDATED_36` | 36 | Adds all four new evidence-backed software buyer families |
| `SOFTWARE_BUYER_BLOAT_CONTROL_40` | 40 | Adds four extra pages but no new demand families |
| `SOFTWARE_GENERIC_INFO_CONTROL_37` | 37 | Adds the 5,400-volume generic informational term and is disqualified |

The deterministic winner is:

`SOFTWARE_BUYER_FRONTIER_FULL_VALIDATED_36`

The 40-page control has the same unique relevant demand as the 36-page strategy and therefore loses on the fewer-pages tie-break. The 37-page informational control cannot win because informational volume is not commercial capacity.

## V4 modeled planning result

With the existing explicit CTR/session planning assumptions, the 36-page winner produces:

- 11,680 monthly searches of **validated representative relevant demand** across all carried-forward and V4 families.
- 773.55 modeled relevant sessions per month.
- 413.10 modeled strict-commercial sessions per month.
- 1.015 modeled clients in the worst original stress funnel.

Compared with the certified V3 32-page baseline, V4 adds:

- 4 pages.
- 1,790 relevant representative monthly searches.
- 123.75 modeled relevant sessions.
- 64.80 modeled strict-commercial sessions.
- 0.163 modeled worst-case clients.

These are deterministic outputs from research estimates plus explicit planning assumptions. They are **not expected outcomes**.

## The 15-client floor still does not pass

At the current modeled 773.55 relevant sessions, the original stress funnels produce approximately:

- HARD: 2.320 modeled clients.
- POOR: 1.856 modeled clients.
- VERY_POOR: 1.015 modeled clients.

The deliberately stronger hypothetical sensitivity funnels produce approximately 2.900, 4.061 and 5.956 modeled clients respectively. Those funnels are labeled `HYPOTHETICAL_PLANNING_ASSUMPTION_NOT_OBSERVED` and cannot be represented as first-party conversion performance.

The validated relevant research universe is now 11,680 representative searches. Even an impossible mathematical upper bound of **100% search-click capture**, reduced only by the existing 0.9 click-to-session assumption, yields 10,512 sessions. At that ceiling the original funnels model approximately:

- HARD: 31.536 clients.
- POOR: 25.228 clients.
- VERY_POOR: 13.797 clients.

Therefore the current research universe still cannot support the 15-client floor across all original stress scenarios, even under the impossible 100% click-capture upper bound. The correct verdict remains:

`EXPAND_VALIDATED_DEMAND_AND_OR_CHANNELS_BEFORE_FLOOR_CLAIM`

This does **not** mean 15 clients are impossible. It means the evidence currently available does not justify claiming a robust 15-client floor.

## What V4 proves

V4 proves that fresh, first-party-offer-aligned software buyer demand adds measurable modeled capacity and that 36 pages beat the 32-page V3 baseline under the deterministic selection policy. It also proves that simply adding more pages does not create market demand, and that a high-volume generic query must remain excluded when its SERP intent is informational.

## Certification boundary

The V4 workflow must prove, on the exact checked-out source revision:

1. V3 regression remains green and selects the certified 32-page baseline.
2. V4 unit/evidence assertions pass.
3. V4 deterministic assertions select the 36-page software-buyer frontier and keep the 15-client floor unsupported.
4. WALLE proves the full SEO Avengers 2500 execution chain with no accepted SKIP / NOT_TESTED substitution.
5. The checkout remains pristine.

Decision boundary:

`PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_VERCEL_OR_TENANT_MUTATION`
