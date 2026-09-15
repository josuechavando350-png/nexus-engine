# NEXUS Commercial Demand Tournament V3

V3 extends the completed V2 tournament with service-portfolio demand that was missing from the earlier seed. It keeps the same conservative demand-family model, adds SERP intent evidence, and converts the 15-client planning floor into explicit traffic/conversion requirement math.

## Boundary

This is a deterministic planning experiment. It is not a rank, traffic, lead, client, revenue or quantum-advantage forecast. No site, CMS, Ads, DNS, Vercel deployment or tenant is mutated by this tournament.

The commercial objective remains a **minimum planning floor of 15 new clients/month**, not a guarantee.

## New evidence

The first-party public Nexus Bot Studio site explicitly presents service lines including Agentes de IA, Llamadas y Mensajes, Automatización, Integraciones, Plataformas a medida, Datos y Analytics, and Estrategia y Consultoría.

V3 adds one exact Google Ads known-keyword snapshot for Mexico / Spanish, bound to HYPD result `8df1cbfe-8a42-4389-af79-b8833785bc59`.

The eight exact representative terms are intentionally split into relevant demand and informational controls:

| Family | Representative term | Monthly volume | Intent used by V3 |
| --- | --- | ---: | --- |
| AI_AGENTS_BUSINESS | agentes de ia para empresas | 20 | MIXED |
| SYSTEM_INTEGRATION | integracion de sistemas | 170 | MIXED |
| TECH_CONSULTING | consultoria tecnologica | 110 | MIXED |
| CUSTOMER_SERVICE_CHATBOT | chatbot atención al cliente | 20 | MIXED |
| AI_VOICE_CALLS | llamadas con inteligencia artificial | 10 | MIXED |
| BI_SERVICES | servicios de business intelligence | 10 | DIRECT |
| AI_AGENTS_GENERIC_INFO | agentes de inteligencia artificial | 260 | INFORMATIONAL |
| DASHBOARD_GENERIC_INFO | dashboard empresarial | 70 | INFORMATIONAL |

The generic AI-agent and dashboard volumes are deliberately **not** promoted to commercial demand. SERP evidence for the relevant families is stored in `service-intent-evidence-v3.json` and fail-closed tests prevent those classifications or keyword metrics from being silently inflated.

No usable connected GA4 conversion property was available for observed lead, qualification or close rates. Funnel rates therefore remain explicit planning assumptions.

## Strategy tournament

V3 preserves the V2 26-page winner as a control, then makes progressively broader service portfolios compete:

| Strategy | Pages | Relevant modeled sessions/month | Worst stress modeled clients/month | Role |
| --- | ---: | ---: | ---: | --- |
| V2_EVIDENCE_WEIGHTED_HYBRID_BASELINE_26 | 26 | ~633.87 | ~0.831 | V2 control |
| SERVICE_FRONTIER_CORE_29 | 29 | ~647.37 | ~0.849 | Adds AI agents, integrations and consulting |
| **SERVICE_FRONTIER_FULL_VALIDATED_32** | **32** | **~649.80** | **~0.852** | **Selected** |
| SERVICE_FRONTIER_BLOAT_CONTROL_38 | 38 | ~649.80 | ~0.852 | Same demand as 32, loses on page efficiency |
| INFORMATIONAL_VOLUME_CONTROL_34 | 34 | commercial capacity unchanged | n/a | Ineligible informational control |

The 32-page strategy wins because all six new relevant service families add unique evidence-backed demand. The 38-page control adds six extra pages but no additional demand family, so it cannot beat the 32-page strategy.

The incremental gain over the V2 26-page winner is deliberately modest:

- +15.93 modeled relevant sessions/month under the planning CTR assumptions.
- +1.08 strict-commercial modeled sessions/month.
- +0.021 modeled clients/month in the worst stress funnel.

That is useful evidence: simply creating more pages for every offered service does not manufacture enough market demand to support a 15-client floor.

## Expanded validated search ceiling

The relevant raw representative search volume rises from 9,550 to **9,890 searches/month** after the new service families are included.

The explicit mathematical 100% search-click-capture ceiling is **8,901 sessions/month** after the click-to-session factor. This is an upper bound for diagnosis, not a plausible traffic forecast.

At that impossible ceiling, the original stress funnels produce approximately:

| Funnel | Modeled clients at 100% search-click capture | 15-client floor supported? |
| --- | ---: | --- |
| HARD_5000 | 26.703 | yes |
| POOR_6250 | 21.362 | yes |
| VERY_POOR_11429 | 11.682 | **no** |

So even after expanding the service portfolio, the currently validated organic search universe cannot support the 15-client floor under the VERY_POOR funnel, even at an impossible 100% click capture.

## Growth frontier

Against the selected strategy's ~649.80 modeled sessions/month, the original stress funnels require:

| Funnel | Sessions required for 15 | Multiple of current modeled sessions |
| --- | ---: | ---: |
| HARD_5000 | 5,000 | ~7.69x |
| POOR_6250 | 6,250 | ~9.62x |
| VERY_POOR_11429 | ~11,428.57 | ~17.59x |

V3 also carries three **hypothetical, non-observed** conversion sensitivity funnels. They exist only to answer "how much traffic would still be required if conversion improved?":

| Sensitivity assumption | Sessions required for 15 | Current modeled clients at ~649.80 sessions |
| --- | ---: | ---: |
| 2.5% lead × 50% qualified × 30% close | 4,000 | ~2.436 |
| 3% lead × 50% qualified × 35% close | ~2,857.14 | ~3.411 |
| 4% lead × 55% qualified × 35% close | ~1,948.05 | ~5.003 |

Even materially better hypothetical conversion does not make ~649.80 modeled sessions sufficient for 15 clients. The next commercial problem is therefore not "publish more pages until the spreadsheet says 15". It is to expand validated acquisition capacity and obtain real first-party funnel evidence while continuing to improve conversion.

## Certification path

The V3 workflow runs:

1. the V2 regression suite;
2. the V3 fail-closed unit suite;
3. deterministic V3 winner, floor, verdict and worst-case assertions; and
4. the full WALLE SEO Avengers execution proof.

The workflow keeps the Python 3.12 environment required by the original Avengers 200 verifier and a separate Python 3.11 WALLE verification environment. SKIPs are not converted into PASS.
