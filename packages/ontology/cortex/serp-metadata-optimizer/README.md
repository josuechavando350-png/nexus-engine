# CORTEX SERP Metadata Optimizer

CORTEX GREEN-SPEC #4 implements a governed metadata optimization loop for **existing, indexable pages**. It reads finalized Google Search Console performance, compares a target page with same-site pages at similar observed positions, selects metadata only from verified page content, and publishes an exact metadata override through a compare-and-swap publisher.

## What this capability does not claim

Google Search result presentation is automated. A page `<title>` is one source Google may use for a title link, and a meta description is one possible snippet source; visible page content remains a primary snippet source. Google can rewrite title links/snippets and can select a different canonical URL. Therefore:

- a successful CORTEX publish means **the governed metadata source changed**, not that Google displayed the same title/snippet;
- Search Console CTR comparisons are observational opportunity signals, not causal proof that metadata caused ranking, traffic, or revenue changes;
- configured title/description character caps are internal quality guardrails, not Google platform limits;
- this module does not auto-submit URLs through the Indexing API or claim instant recrawling; Google may take days or weeks to recrawl/reprocess changes;
- CORTEX #5 owns headless/programmatic page generation;
- CORTEX #24 owns statistical rollback. This module only provides exact operational rollback of its last certified metadata mutation.

Current external contracts were checked against:

- Google Search Console Search Analytics API: https://developers.google.com/webmaster-tools/v1/searchanalytics/query
- Google title link guidance: https://developers.google.com/search/docs/appearance/title-link
- Google snippet guidance: https://developers.google.com/search/docs/appearance/snippet
- Google canonical guidance: https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls

## Inputs

### Page inventory

`PageInventoryProvider` supplies a versioned snapshot containing:

- page ID and URL;
- locale and site name;
- indexability;
- canonical URL;
- current title and meta description;
- primary visible heading;
- visible page text;
- bounded summary candidates that are verified to occur in visible content.

The optimizer fails closed when the inventory is stale, the page is not indexable, or the page is not self-canonical. It does not invent marketing claims or pull Search Console queries into page copy.

### Search Console

`SearchConsoleRestClient` uses the Search Analytics endpoint with OAuth, `type=web` and `dataState=final`. It collects:

1. page-level rows for same-site peer comparison;
2. page+query rows filtered to the exact target page for candidate scoring.

The adapter honors the 25,000-row request limit and a configured total evidence budget. Search Analytics is explicitly represented as `TOP_ROWS_BOUNDED`: Google documents that the API is subject to internal limits and does not guarantee every row. Missing queries are never interpreted as zero demand.

Raw query strings are transient. Durable CORTEX run/state records contain aggregate metrics and a SHA-256 query-evidence digest, not query text.

## Decision rule

A write requires all of the following:

1. fresh page inventory;
2. indexable self-canonical target page;
3. minimum target impressions;
4. enough same-site page peers within the configured average-position tolerance;
5. an observational expected-click opportunity above policy threshold;
6. a candidate different from currently published metadata.

Title candidates are derived from the page's existing primary heading and optional site name, reject excessive token repetition and avoid duplicate titles in the supplied inventory. Description candidates must be exact normalized spans already present in visible page content. Search queries only score those pre-existing candidates.

The evidence record permanently states:

`OBSERVATIONAL_CTR_OPPORTUNITY_NOT_CAUSAL_RANKING_OR_SERP_GUARANTEE`

## Actuation and renderer boundary

`JsonFileMetadataPublisher` is a concrete server-side actuator. It writes a canonical manifest using:

- an exclusive writer lock;
- compare-and-swap against the exact observed revision/digest;
- temp-file write + file `fsync` + atomic rename;
- post-write read-back certification;
- deterministic JSON ordering.

The same publisher exposes `read(siteUrl, pageId, pageUrl)` for server-side render/build consumption. A renderer must use that read boundary (or an equivalent `MetadataPublisher` implementation) and fall back to the page inventory metadata when no override exists. Publishing a manifest without a renderer consuming it is **not** evidence that live HTML changed.

The default file publisher is appropriate when the deployment/build system shares the manifest filesystem. Other production environments can implement the same `MetadataPublisher` interface against their actual CMS/configuration store while preserving CAS and certification semantics.

## Recovery and rollback

Each mutation is prepared durably before the external write. If the publisher outcome is ambiguous, the run remains `PREPARED`. A later `ACTIVE` execution replays the same action; the publisher first checks whether the desired state already exists and can return `recoveredAlreadyApplied=true` without creating another revision.

If the publish succeeds but local ontology finalization fails, the same preflight path recovers the applied write on the next run without re-reading Search Console or the page inventory.

After a certified apply, CORTEX stores the exact inverse action. `rollbackLastMutation()` removes an override that CORTEX created or restores the exact previous override using compare-and-swap. Any third-party drift causes a conflict rather than destructive rollback.

## Operating modes

- `ACTIVE`: evaluate and publish one certified metadata mutation per run.
- `OBSERVE_ONLY`: evaluate and persist the exact proposed action but never call the publisher write method.
- `KILLED`: for a new run, does not read page inventory, Search Console, or publisher state.

A prepared `ACTIVE` mutation cannot be silently executed under `OBSERVE_ONLY` or `KILLED`; explicit `ACTIVE` recovery is required.

## Production activation

A production deployment must provide:

- real Search Console OAuth credentials authorized for the property;
- a fresh page inventory built from the controlled site source/rendered pages;
- durable `OntologyTransactionPort` storage (the existing SQLite adapter is supported);
- a publisher whose output is consumed by the site renderer/build;
- telemetry/error sinks and an operator-controlled mode/kill switch.

No credentials, Search Console access, live client data, or live SERP effects are faked by this package.
