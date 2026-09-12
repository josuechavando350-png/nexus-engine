# SEO Avengers 2500 — integration map (current M1001-M2000)

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
        |        |
        |        v
        |     M1391-M1399 exact readiness guards
        |        |
        |        v
        |      M1400 readiness certifier
        |
        +--> M1401-M1590  Local Authority Graph + Conversion Intelligence
        |        |
        |        v
        |     M1591-M1599 exact local-growth guards
        |        |
        |        v
        |      M1600 local-growth certifier
        |
        +--> M1601-M1690  Discovery Velocity
        |        |
        |        +--> canonicalization_records
        |        +--> persistence_state_records
        |        +--> edge_gateway_records
        |        +--> cwv_edge_records
        |        +--> policy_audit_records
        |        +--> first-party search/content evidence
        |        v
        |     M1691-M1699 exact discovery guards
        |        |
        |        v
        |      M1700 discovery certifier
        |
        +--> M1701-M1790  Local Topical Lattice
        |        |
        |        +--> search_intent_records
        |        +--> semantic_text_records
        |        +--> verified project service/location vocabulary
        |        +--> content/local identity/search evidence
        |        v
        |     M1791-M1799 exact topical guards
        |        |
        |        v
        |      M1800 topical certifier
        |
        +--> M1801-M1890  Local Demand Frontier
        |        |
        |        +--> search_performance_records
        |        +--> content_documents
        |        +--> canonicalization_records
        |        +--> search_intent_records
        |        +--> semantic_text_records
        |        +--> local_business_records
        |        v
        |     90 first-party demand/opportunity measurements
        |        |
        |        v
        |     M1891-M1899 exact frontier guards
        |        |
        |        v
        |      M1900 frontier certifier
        |
        +--> M1901-M1990  Internal Authority Counterfactual
        |        |
        |        +--> existing silo/internal-link evidence
        |        +--> observed search demand
        |        +--> canonical/content/entity evidence
        |        v
        |     deterministic topology + counterfactual simulation
        |        |
        |        +--> never mutates site
        |        +--> never creates links
        |        +--> never claims Google PageRank
        |        v
        |     M1991-M1999 exact counterfactual guards
        |        |
        |        v
        |      M2000 current exact certifier
        |
        +--> M2001-M2500 RESERVED_NOT_EXECUTABLE
```

## Evidence boundary

Current local modules consume only evidence contracts already present in NEXUS:

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

Every M1001-M2000 spec is:

```text
policy_status = SAFE_WHITE_HAT
action_mode   = OBSERVE_ONLY
```

The runtime cannot publish pages, edit HTML, generate doorway pages, build external links, scrape Google or write to external infrastructure. Successful receipts hash-bind:

```text
new_external_api_required     = false
new_database_required         = false
new_queue_required            = false
new_secret_required           = false
new_cloud_resource_required   = false
new_daemon_required           = false
```

A recommendation becoming a production change remains a separate reviewed action outside this observe-only suite.

## Demand Frontier boundary

M1801-M1890 model **observed first-party demand**, not Google's private ranking system:

```text
Search observation
      |
      +--> intent / service / location classification
      +--> observed landing
      +--> supplied content
      +--> canonical / sitemap / inlink evidence
      +--> semantic / local identity corroboration
      |
      v
fixed-point demand frontier
      |
      +--> CTR / zero-click / position-band structure
      +--> long-tail / local / commercial / urgency exposure
      +--> service×location cells
      +--> concentration / Pareto / fragmentation health
      +--> evidence-backed opportunity diagnostics
```

Every output carries explicit non-claim semantics: no Google scraping, no ranking forecast, no revenue forecast and no indexation guarantee.

## Internal Authority Counterfactual boundary

M1901-M1990 simulate only the site's supplied internal graph:

```text
search_intent_records
   silo + internal_link_targets
             |
             v
      directed internal graph
             |
             +--> components / reachability
             +--> orphan/source/sink structure
             +--> bridges / articulations / cycles
             +--> shortest paths / radius / diameter
             +--> demand-weighted topology
             |
             v
       candidate edge simulation
             |
             +--> reachability gain
             +--> demand reach gain
             +--> redundancy/resilience gain
             +--> path-depth reduction
             +--> semantic/entity/query/canonical support
             |
             v
      OBSERVE_ONLY recommendation evidence
```

The simulation never inserts the candidate edge. It is not PageRank, does not create external links and cannot become a link scheme by itself.

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
```

For extension batches, nine guards verify predecessor safety, current receipt hashes, execution success, policy/action metadata, forbidden claims, zero-new-infrastructure, exact source mapping, algorithm uniqueness and existing-contract-only evidence. The terminal module binds the predecessor plus exactly those nine guard receipts.

M2000 certifies only the current local range M1001-M2000. It is **not** the future final M2500 terminal certifier.

## Current cardinality

```text
M001-M1000    delegated audited predecessor  = 1000
M1001-M2000   implemented here               = 1000
M2001-M2500   reserved, non-executable       =  500
----------------------------------------------------
final target                                = 2500
```

The manifest requires exactly 1000 local operation names and 1000 functional fingerprints with exact source mapping M2001-M3000. Reserved modules cannot execute.
