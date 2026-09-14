# WALLE + SEO Avengers — Authorized Real-Data Ingestion Contract

This layer is the write-authorized counterpart to the existing read-only evidence boundary. It is intentionally **not** a Google/GA/GBP network client. It accepts already-authorized provider observations, verifies their provenance digest and schema, converts them into the existing SEO Avengers dataset contracts, and publishes a coherent tenant snapshot for the read-only worker.

## Why this boundary exists

SEO Avengers remains deterministic and credential-free. Provider credentials, OAuth refresh tokens, browser sessions and API clients do not enter the Avengers runtime or sidecar. A future provider adapter may call an authorized API, but it must terminate at this contract and hand over only normalized evidence.

The publisher has evidence authority only. It reads the tenant control plane and cannot enable a tenant, clear a kill switch, publish to a CMS, alter DNS, create links, modify Google Business Profile, or execute Avengers.

## Supported evidence sources

The first contract covers the minimum evidence needed to measure search growth without fabricating outcomes:

- `GOOGLE_SEARCH_CONSOLE` -> `search_performance_records`
  - query
  - landing page
  - clicks
  - impressions
  - average position represented as integer milli-units
- `GOOGLE_ANALYTICS_4` -> `traffic_window_records` and `traffic_series_records`
  - comparable traffic windows
  - bounded integer visit series
- `GOOGLE_BUSINESS_PROFILE` -> `local_business_records`
  - verified business identity fields and integer micro-degree coordinates
- `NEXUS_SITE_SNAPSHOT` -> `content_documents`
  - observed site content used by the existing deterministic semantic/local modules
- `NEXUS_CRM` -> `revenue_funnel_records`
  - aggregated sessions, lead rate, close rate and average ticket
  - no customer names, emails, phone numbers or raw CRM identities

The publisher also creates `upstream_evidence` automatically. Each provenance row binds provider, dataset key, capture ID, observation time, record count and the canonical SHA-256 supplied for the normalized provider records.

## Provider snapshot envelope

A snapshot has exact fields:

```json
{
  "schema_version": 1,
  "site_id": "tenant-id",
  "control_generation": 7,
  "capture_id": "gsc-ga4-2026-09-14",
  "observed_at_unix_ms": 1789344000000,
  "datasets": [
    {
      "provider": "GOOGLE_SEARCH_CONSOLE",
      "key": "search_performance_records",
      "records": [],
      "records_sha256": "sha256:<canonical records digest>"
    }
  ]
}
```

The collector must compute `records_sha256` over the same canonical JSON contract exposed by `canonicalProviderRecordsSha256()`. Floating-point values are rejected; external decimal measurements must be converted deliberately to the integer unit required by the dataset contract before publication.

Extra row fields fail closed. This prevents credentials or accidental provider payload fields from silently entering the SEO evidence store.

## Publication safety

Publication requires an integrity-valid, currently enabled tenant with the kill switch clear. `site_id` and `control_generation` must match the control plane exactly.

The next snapshot is fully staged outside `tenants/`. Immediately before commit, control authorization is re-read. Existing tenant evidence is moved aside, the complete staged directory is renamed into place, and the previous snapshot is removed only after the new directory is present. A failed replacement attempts rollback. A crash can make evidence temporarily absent or digest-invalid, but the read-only evidence boundary then returns `INSUFFICIENT_DATA`/`BLOCKED`; it cannot promote a partial snapshot to `READY`.

After publication, control is read again. A concurrent disable, kill switch or generation movement makes the publisher return `STALE`. The generation-bound manifest also prevents the worker from releasing that evidence under a different control generation.

The publisher never mutates the control plane.

## What this enables next

With real authorized observations flowing through this boundary, WALLE can measure rather than guess:

- current query/page positions and distance from Top 3 / Top 1;
- impression and click opportunity by intent cluster;
- actual organic traffic movement over comparable windows;
- local identity consistency and local-search evidence;
- observed lead and close rates plus average ticket from aggregated CRM data.

That does **not** make a Top #1 prediction a fact. The next simulation layer should produce bounded scenarios (for example conservative/base/upside) using observed demand, current position, CTR response assumptions supplied as explicit model inputs, and the measured funnel. It must label those results as scenarios, not ranking or revenue guarantees.

Likewise, customer volume can be estimated only as a funnel scenario: additional qualified organic sessions x observed lead conversion x observed close rate. Actual signed clients must continue to be measured by WALLE's growth-attribution ledger.

## Scope

This PR does not connect a real tenant, store provider credentials, call Google, start a scheduler, or grant mutation authority. CANO, SOMA and Nexus Bot Studio remain outside the proof path until an explicit production activation decision is made.
