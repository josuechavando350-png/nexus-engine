# SEO Avengers 2500 — integration map (current M1001-M1200 batch)

## Runtime chain

```text
seo-avengers-1000 (M001-M1000 audited predecessor)
        |
        v
seo-avengers-2500/runtime/catalog.py
        |
        +--> M001-M1000 DELEGATED_PRODUCTION
        |
        +--> M1001-M1200 IMPLEMENTED_PRODUCTION
        |        |
        |        +--> search_performance_records
        |        +--> local_business_records
        |        +--> content_documents
        |        +--> content_decay_records
        |        +--> upstream_evidence
        |
        |        v
        |   module_runtime.py
        |        |
        |        v
        |   kernels.py + kernel_* shards
        |        |
        |        v
        |   canonical receipts
        |        |
        |        v
        |   M1176-M1199 policy receipts
        |        |
        |        v
        |      M1200 strict white-hat release gate
        |
        +--> M1201-M2500 RESERVED_NOT_EXECUTABLE
```

## Existing data only

This batch consumes only payload families already present in the repository's SEO Avengers extension contracts. It does not add a provider or persistence dependency.

Expected configuration is local factual vocabulary supplied by the caller/project:
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

These are project facts/configuration, not third-party API data.

## No client mutation

All M1001-M1200 modules are observation/recommendation evidence only. They do not edit `apps/**` or `delivery/**`. A future application layer may consume receipts, but production mutation must remain a separately reviewed and approved capability.

## Next build slices

The final target remains exact M001-M2500. Later batches must preserve the same constraints: no fabricated evidence, no new infrastructure requirement, no gray/uncertain Google-search tactics, and no promotion without tests and functional-deduplication review.
