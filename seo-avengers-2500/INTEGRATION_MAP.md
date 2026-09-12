# SEO Avengers 2500 — integration map (current M1001-M2200)

```text
seo-avengers-1000  [M001-M1000 audited predecessor]
        |
        v
seo-avengers-2500/runtime/catalog.py
        |
        +--> M001-M1000   DELEGATED_PRODUCTION
        |
        +--> M1001-M1199  demand/entity/content + white-hat diagnostics
        |        |
        |        v
        |      M1200 strict white-hat gate
        |
        +--> M1201-M1390  Local Opportunity Twin + Proof Fusion
        |        v
        |     M1391-M1399 readiness guards -> M1400
        |
        +--> M1401-M1590  Local Authority Graph + Conversion Intelligence
        |        v
        |     M1591-M1599 growth guards -> M1600
        |
        +--> M1601-M1690  Discovery Velocity
        |        +--> canonicalization / persistence / gateway / edge / policy evidence
        |        v
        |     M1691-M1699 discovery guards -> M1700
        |
        +--> M1701-M1790  Local Topical Lattice
        |        +--> search intent / semantic entities / verified project vocabulary
        |        v
        |     M1791-M1799 topical guards -> M1800
        |
        +--> M1801-M1890  Local Demand Frontier
        |        +--> first-party search / content / canonical / identity evidence
        |        v
        |     M1891-M1899 frontier guards -> M1900
        |
        +--> M1901-M1990  Internal Authority Counterfactual
        |        +--> supplied internal graph + demand/entity/canonical evidence
        |        +--> deterministic what-if simulation only
        |        v
        |     M1991-M1999 link guards -> M2000
        |
        +--> M2001-M2090  Proof-Carrying Search Representation Mesh
        |        +--> query <-> title/meta/headings/alts/anchors/navigation
        |        +--> JSON-LD types <-> factual identity/content/entities
        |        +--> policy/robots/human-bot/domain/site proof
        |        +--> semantic/canonical/local-identity corroboration
        |        v
        |     M2091-M2099 representation guards -> M2100
        |
        +--> M2101-M2190  Local Entity Proof Graph
        |        +--> semantic entities and supplied related_ids only
        |        +--> query/content/local/canonical/schema corroboration
        |        +--> topology/resilience/counterfactual bridge analysis
        |        +--> no invented entity/location/service/review
        |        v
        |     M2191-M2199 entity-graph guards -> M2200
        |
        +--> M2201-M2500 RESERVED_NOT_EXECUTABLE
```

## Evidence boundary

M1001-M2200 consume only contracts already present in NEXUS:

```text
search_performance_records
content_documents
local_business_records
content_decay_records
revenue_funnel_records
upstream_evidence
search_intent_records
canonicalization_records
persistence_state_records
edge_gateway_records
cwv_edge_records
policy_audit_records
semantic_text_records
```

Project configuration contains factual vocabulary/grouping (`local_service_terms`, `local_location_terms`, verified service/location terms, service/location groups, brand/commercial/urgency/question terms and explicit organic funnel source IDs). These are project facts, not external data providers.

## Strict white-hat action boundary

Every M1001-M2200 spec is:

```text
policy_status = SAFE_WHITE_HAT
action_mode   = OBSERVE_ONLY
```

The runtime cannot publish pages, edit HTML, generate doorway pages, create external links, scrape Google, fabricate reviews/locations/services/entities/schema facts, or write to external infrastructure. Successful receipts hash-bind:

```text
new_external_api_required     = false
new_database_required         = false
new_queue_required            = false
new_secret_required           = false
new_cloud_resource_required   = false
new_daemon_required           = false
```

A recommendation becoming a production change remains a separately reviewed action outside this observe-only suite.

## Search Representation Proof boundary

M2001-M2090 treat search representation as a proof graph rather than a bag of tags:

```text
observed query / intent
      |
      +--> title / meta / headings
      +--> image alt / internal anchors / navigation entities
      +--> supplied content
      |
      +--> semantic entities / project provenance
      +--> factual local identity
      +--> canonical query cluster / schema signature
      +--> supplied JSON-LD type evidence
      +--> robots / domain / site / human-bot policy evidence
      |
      v
proof-carrying representation mesh
      |
      +--> alignment scores
      +--> contradiction checks
      +--> evidence breadth
      +--> deterministic receipt
```

It never synthesizes missing structured-data facts and never promises a rich result. `no_schema_fabrication`, `no_rich_result_guarantee`, `no_rank_guarantee`, `no_google_scraping` and `no_site_mutation` are explicit output semantics.

## Local Entity Proof Graph boundary

M2101-M2190 build a local NEXUS graph from supplied semantic evidence only:

```text
semantic_text_records.entities
       id / label / type
       related_ids
       salience / properties / schema_types / external_context
                    |
                    v
             local entity graph
                    |
                    +--> components / isolation / reciprocity
                    +--> degree / hub / bridge / articulation resilience
                    +--> reachability / cycles / type mixing
                    |
                    +--> observed queries and demand
                    +--> supplied content/headings/anchors/cache
                    +--> local business identity
                    +--> canonical entity inventory / query clusters
                    +--> JSON-LD type evidence
                    |
                    v
            proof and conflict diagnostics
```

This graph is **not Google's private Knowledge Graph**. Missing nodes/edges are not hallucinated. Counterfactual bridge metrics simulate structural possibilities but do not insert relationships or mutate the client site.

Explicit semantics include:

```text
not_google_knowledge_graph = true
not_google_pagerank        = true
no_entity_fabrication      = true
no_location_fabrication    = true
no_service_fabrication     = true
no_review_fabrication      = true
no_site_mutation           = true
```

## Exact certification chain

Each boundary is cryptographically chained through deterministic SHA-256 receipts:

```text
M1200
  -> M1400
  -> M1600
  -> M1700
  -> M1800
  -> M1900
  -> M2000
  -> M2100
  -> M2200
```

For extension batches, nine guards verify predecessor safety, current receipt hashes, execution success, policy/action metadata, forbidden claims, zero-new-infrastructure, exact source mapping, algorithm uniqueness and existing-contract-only evidence. The terminal module binds the predecessor plus exactly those nine guard receipts.

M2200 certifies only the current local range M1001-M2200. It is **not** the future final M2500 terminal certifier.

## Current cardinality

```text
M001-M1000    delegated audited predecessor  = 1000
M1001-M2200   implemented here               = 1200
M2201-M2500   reserved, non-executable       =  300
----------------------------------------------------
final target                                = 2500
```

The manifest requires exactly 1200 local operation names and 1200 functional fingerprints with exact source mapping M2001-M3200. Reserved modules cannot execute.
