# NEXUS Commercial Demand Tournament V5

## Purpose

V5 adds an **offer-fit gate** to the certified V4 commercial-demand tournament. The planning objective remains a minimum floor of **15 new clients per month**, not a promise, probability, traffic forecast, ranking guarantee, lead guarantee, client forecast or revenue forecast.

The new gate prevents the tournament from inflating NEXUS capacity with large keyword markets that may have buyer intent but are aimed at products or services NEXUS does not explicitly offer. V5 remains plan-only and does not mutate production, Vercel, DNS, Ads, CMS or any tenant.

## Certified baseline

V5 chains through V4 and fails closed unless V4 still selects:

`SOFTWARE_BUYER_FRONTIER_FULL_VALIDATED_36`

with 36 explicit page IDs and the certified V4 capacity.

## Fresh research

V5 reviewed a broad Mexico / Spanish discovery set of **2,656 candidate rows** under result `00d4509d-a716-4d3b-93be-8e4b51a4d9f7`. Discovery rows are candidates only and are never summed as unique demand.

A separate exact known-keyword snapshot, result `46c867ce-8050-4ce6-a485-f13083945c78`, binds nine representative terms. Across those nine terms there are **9,410 monthly research searches**, but only **70** are allowed to add new capacity after the offer-fit and overlap gates.

### Additive V5 families

| Family | Representative keyword | Intent | Monthly research volume | Competition index | First-party fit |
| --- | --- | --- | ---: | ---: | --- |
| `AI_CONSULTING_SPECIALIZED` | `consultoria inteligencia artificial` | MIXED | 30 | 59 | Estrategia y Consultoría |
| `CUSTOM_ERP` | `erp a medida` | MIXED | 10 | 71 | Plataformas a medida |
| `CUSTOM_CRM` | `crm a medida` | MIXED | 10 | 86 | Plataformas a medida |
| `DATA_CONSULTING` | `consultoria de datos` | MIXED | 20 | 71 | Datos y Analytics |

Each family has a separate Mexico / Spanish SERP evidence result. All four remain MIXED rather than being promoted to direct transactional demand.

## Offer-fit guards

V5 explicitly records large markets that **do not** add NEXUS capacity:

| Guard | Keyword | Monthly research volume | Why it adds zero |
| --- | --- | ---: | --- |
| `ERP_SYSTEMS_GENERIC_INFORMATIONAL` | `sistemas erp` | 6,600 | Generic SERP is definitions, examples and established packaged ERP vendors |
| `POS_ADJACENT_PRODUCT` | `puntos de venta para negocios` | 2,400 | SERP is retail POS hardware, payment terminals and off-the-shelf POS software |
| `SOFTWARE_MANAGEMENT_ADJACENT_PRODUCT` | `software de gestion empresarial` | 140 | SERP is packaged management software, vendor comparisons and definitions |
| `ECOMMERCE_DEVELOPMENT_OFFER_UNPROVEN` | `desarrollo de ecommerce` | 30 | Commercial/mixed SERP exists, but current first-party service evidence does not explicitly establish ecommerce development as an offered line |

A fifth guard, `AI_COMPANY_EXISTING_FAMILY_SYNONYM`, records `empresa de inteligencia artificial` at 170 monthly research searches as a synonym/overlap of the already modeled `AI_COMPANY` family. It contributes zero incremental capacity.

Therefore V5 excludes **9,340 of the 9,410** monthly searches in the exact fresh snapshot from incremental capacity. This is intentional. The tournament must not reach the 15-client target by absorbing adjacent or duplicate markets.

## Strategies

The certified 36-page V4 winner competes against:

- `OFFER_FIT_CORE_38`: adds AI consulting and data consulting.
- `OFFER_FIT_FULL_VALIDATED_40`: adds all four first-party-aligned distinct V5 families.
- `OFFER_FIT_BLOAT_CONTROL_44`: adds four more pages without new demand families.

The deterministic winner is expected to be:

`OFFER_FIT_FULL_VALIDATED_40`

The 44-page strategy must lose on the fewer-pages tie-break because it covers the same unique relevant demand.

## V5 planning result

The 40-page winner carries forward V4 and adds only the 70 monthly searches that survive the V5 gate:

- Validated representative relevant demand: **11,750 searches/month**.
- Modeled relevant sessions: **776.70/month**.
- Modeled strict-commercial sessions: **413.10/month**.
- Worst original stress modeled clients: **1.019/month**.

Compared with certified V4, V5 adds:

- 4 explicit pages.
- 70 representative relevant monthly searches.
- 3.15 modeled relevant sessions.
- 0 strict-commercial sessions because all four new families remain MIXED.
- 0.004 modeled worst-case clients.

These are deterministic planning outputs from research estimates and explicit assumptions. They are not expected outcomes.

## The 15-client floor still does not pass

At 776.70 modeled relevant sessions, the original stress funnels model approximately:

- HARD: 2.330 clients.
- POOR: 1.864 clients.
- VERY_POOR: 1.019 clients.

The hypothetical sensitivity funnels model approximately 2.912, 4.077 and 5.980 clients. They remain explicitly hypothetical and are not first-party conversion evidence.

The validated relevant research universe becomes 11,750 representative searches. Even the impossible upper bound of 100% click capture, reduced only by the existing 0.9 click-to-session assumption, is 10,575 sessions. At that upper bound:

- HARD: 31.725 modeled clients.
- POOR: 25.380 modeled clients.
- VERY_POOR: 13.879 modeled clients.

The VERY_POOR stress case therefore remains below the 15-client planning floor even at impossible 100% click capture. The verdict remains:

`EXPAND_VALIDATED_DEMAND_AND_OR_CHANNELS_BEFORE_FLOOR_CLAIM`

## What V5 proves

V5 proves a more important property than simply finding more keywords: the tournament can **reject tempting high-volume markets** when they are informational, adjacent products, not explicitly supported by the first-party offer, or semantic duplicates of already modeled demand.

This creates a stricter commercial boundary for future rounds. New demand can only increase modeled capacity when it is both search-relevant and genuinely connected to an offer NEXUS can sell.

Decision boundary:

`PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_VERCEL_OR_TENANT_MUTATION`
