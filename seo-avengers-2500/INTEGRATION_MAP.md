# SEO Avengers 2500 — integration map (current M1001-M1400)

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
        |      M1400 current-batch readiness certifier
        |
        +--> M1401-M2500 RESERVED_NOT_EXECUTABLE
```

## Existing data contracts only

No new infrastructure contract is introduced. Current modules consume payload families already present in the repository. The only added configuration consists of factual project vocabulary/grouping and an explicit list of which existing funnel `source_id` values represent organic traffic:

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

These are local project facts/configuration, not provider data.

## Safety boundaries

M1001-M1400 are evidence-only and `OBSERVE_ONLY`. They do not edit `apps/**`, `delivery/**`, HTML, links or external services. Future application of a recommendation remains a separately reviewed action.

`upstream_evidence` is not trusted blindly. M1301-M1400 recompute the supplied receipt evidence hash before using proof state. Missing proof yields unknown/insufficient evidence, not a fabricated pass.

Search observation is never equated with indexation. A content page that has no supplied Search performance row is reported as `SEARCH_UNOBSERVED`, not `UNINDEXED`.

## Current certification boundary

M1200 certifies only the strict white-hat policy slice M1176-M1199.

M1400 certifies the current readiness boundary by binding:
- M1200; and
- exact M1391-M1399 readiness guards.

M1400 is **not** the final M2500 terminal certifier. The final certifier will only be implemented after M1401-M2499 are real, connected and audited.
