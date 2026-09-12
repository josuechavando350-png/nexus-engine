# SEO Avengers 2500 — integration map (current M1001-M1600)

```text
seo-avengers-1000  [M001-M1000 audited predecessor]
        |
        v
seo-avengers-2500/runtime/catalog.py
        |
        +--> M001-M1000   DELEGATED_PRODUCTION
        |
        +--> M1001-M1200  local demand/entity/content + white-hat firewall
        |        |
        |        +--> search_performance_records
        |        +--> local_business_records
        |        +--> content_documents
        |        +--> content_decay_records
        |        +--> upstream_evidence
        |        v
        |      M1200 strict white-hat gate
        |
        +--> M1201-M1300  Local Opportunity Twin
        |        |
        |        +--> search_performance_records
        |        +--> content_documents
        |        +--> revenue_funnel_records
        |        +--> factual project term/group configuration
        |
        +--> M1301-M1390  Indexation Readiness / Proof Fusion
        |        |
        |        +--> upstream_evidence receipts
        |        +--> search_performance_records
        |        +--> content_documents
        |        v
        |     M1391-M1399 fail-closed readiness guards
        |        |
        |        +--> requires M1200 safe receipt
        |        v
        |      M1400 readiness certifier
        |
        +--> M1401-M1500  Local Authority Graph
        |        |
        |        +--> observed query <-> landing graph
        |        +--> content-document evidence
        |        +--> local-business identity evidence
        |        +--> service/location grouping facts
        |        v
        |      structural authority diagnostics
        |
        +--> M1501-M1590  Local Conversion Intelligence
        |        |
        |        +--> observed search performance
        |        +--> supplied content/local identity
        |        +--> existing revenue_funnel_records
        |        +--> organic_funnel_source_ids
        |        v
        |      bounded priority indices, never forecasts
        |
        +--> M1591-M1599  Local Growth Certification guards
        |        |
        |        +--> requires M1400 safe receipt
        |        +--> recomputes M1401-M1590 receipt hashes
        |        +--> verifies white-hat / observe-only metadata
        |        +--> verifies no forecast/manipulation claims
        |        +--> verifies zero-new-infrastructure contract
        |        +--> verifies source map / algorithm uniqueness
        |        v
        |      M1600 exact current-batch certifier
        |
        +--> M1601-M2500 RESERVED_NOT_EXECUTABLE
```

## Existing data contracts only

No new infrastructure contract is introduced. Current modules consume payload families already present in the repository. Project-local configuration is factual vocabulary/grouping plus an explicit list of which existing funnel `source_id` values represent organic traffic:

- `local_commercial_terms`
- `local_service_terms`
- `local_location_terms`
- `local_urgency_terms`
- `local_question_terms`
- `local_brand_terms`
- `local_verified_service_terms`
- `local_verified_location_terms`
- `local_service_groups`
- `local_location_groups`
- `organic_funnel_source_ids`

These are project facts/configuration, not a new provider or secret.

## Authority-graph boundary

The authority layer does **not** claim access to Google PageRank or any private Google ranking signal. Its graph is constructed only from supplied evidence:

```text
observed query
      |
      +--> observed landing URL
      |       |
      |       +--> supplied content document
      |       +--> supplied local-business identity evidence
      |
      +--> configured factual service/location/intent groups
```

It can measure connected components, overlap, fragmentation, concentration, service×location cells and content/identity support without mutating the client site.

## Conversion boundary

Conversion Intelligence uses Search observations and the existing `revenue_funnel_records` contract. Existing funnel rates may change **priority**, but the layer does not output predicted leads, predicted clients, revenue forecasts, or guaranteed ranking gains.

```text
observed demand
      |
      +--> content / identity / visibility diagnostics
      |
      +--> explicitly supplied organic funnel evidence
      |
      v
bounded review-priority indices
      |
      +--> not_a_revenue_forecast = true
      +--> OBSERVE_ONLY
```

## Hash-bound zero-infrastructure contract

Every successful local receipt includes a `runtime_contract` declaring:

```text
new_external_api_required     = false
new_database_required         = false
new_queue_required            = false
new_secret_required           = false
new_cloud_resource_required   = false
new_daemon_required           = false
```

Because this object is part of the receipt output, it is covered by the receipt evidence hash. M1597 verifies the exact current batch rather than trusting documentation alone.

## Safety boundaries

M1001-M1600 are evidence-only and `OBSERVE_ONLY`. They do not edit `apps/**`, `delivery/**`, HTML, external links or external services. Future application of a recommendation remains a separately reviewed action.

`upstream_evidence` is not trusted blindly. Proof-fusion layers recompute supplied receipt hashes before using proof state. Missing proof yields unknown/insufficient evidence, not a fabricated pass.

Search observation is never equated with indexation. A content page with no supplied Search performance row is reported as unobserved/not supplied, not `UNINDEXED`.

## Current certification boundaries

M1200 certifies only the strict white-hat policy slice M1176-M1199.

M1400 binds M1200 plus exact M1391-M1399 readiness guards.

M1600 binds M1400 plus exact M1591-M1599 local-growth guards. Its certified local range is M1001-M1600.

M1600 is **not** the final M2500 terminal certifier. The final certifier will only be implemented after M1601-M2499 are real, connected and audited.
