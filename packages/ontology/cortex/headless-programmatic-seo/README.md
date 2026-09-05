# CORTEX Headless Programmatic SEO

CORTEX GREEN-SPEC #5 compiles a controlled content catalog into deterministic, renderable page artifacts. The capability is framework-agnostic inside `@nexus/ontology`, while its plain-data adapters map to the current Next.js App Router metadata-file conventions.

## Non-claims and search-policy boundary

This module does not guarantee ranking, indexing, a Google-selected canonical, title link, snippet, traffic, leads, or revenue. Search engines make those decisions independently.

It also does not create pages by varying a keyword, city, or template for the purpose of manipulating rankings. Google classifies large-scale low-value content and doorway pages as spam. An indexable page must originate in a controlled source with page-specific evidence and distinctive visible statements, and the indexable set must pass duplicate-title, duplicate-description, shared-statement, hierarchy, and near-duplicate checks.

CORTEX #25 owns the future hyperlocal long-tail layer. #5 must not be used to pre-implement that capability through manufactured location permutations.

## Controlled source contract

`ProgrammaticSeoCatalogProvider` supplies a digest-bound snapshot containing stable site/page identities, an HTTPS base URL, canonical UTC timestamps, normalized route segments, a browsable parent hierarchy, visible page content, page-specific distinctive statements, evidence references, indexability, and optional canonical paths.

The engine rejects stale/tampered catalogs, future page timestamps, duplicate IDs/routes, malformed routes, missing evidence for indexable pages, parent cycles, missing parents, route/parent mismatches, and indexable descendants of non-indexable ancestors.

## Anti-doorway and scaled-content guardrails

For indexable pages, compilation requires a configured minimum of distinctive visible statements, no distinctive statement reused by another indexable page, unique titles and descriptions, self-canonical URLs, a browsable hierarchy for non-root pages, and bounded exact five-token-shingle Jaccard similarity below policy threshold.

The similarity check is exact, not approximate. Shingle sets are precomputed and impossible pairs are skipped by a size bound, but worst-case pair evaluation remains quadratic. The hard bundle limit is 2,000 pages and the aggregate visible-body limit is 20,000,000 characters. Larger estates must be partitioned into separately governed bundles; this implementation does not claim unbounded scale.

These checks reduce obvious doorway/scaled-content failure modes. They do not replace editorial review or guarantee search-policy compliance.

## Deterministic render bundle

`compileProgrammaticSeoBundle()` emits pages ordered by route path, normalized page/canonical URLs, breadcrumbs, content digests, dynamic-route static params, sitemap entries for indexable pages, robots metadata, source/policy digests, and one deterministic bundle digest.

Non-indexable pages remain renderable and therefore remain in static route parameters, but are omitted from the sitemap and receive `robots.index=false` from `toNextMetadata()`.

`robots.txt` is deliberately not used as a deindexing mechanism. Generated robots rules allow crawling, including pages carrying `noindex`, because page-level `noindex` cannot be observed when robots.txt blocks the crawl.

## Next.js App Router boundary

The package does not depend on `next`. It exports plain-data adapters:

- `toNextMetadata(page)` for title, description, canonical and robots metadata;
- `toNextStaticParams(bundle)` for dynamic route generation;
- `toNextSitemap(bundle)` for `app/sitemap.ts`;
- `toNextRobots(bundle)` for `app/robots.ts`.

The contracts were checked against current Next.js App Router documentation in September 2026.

## Canonical behavior

Indexable generated pages must be self-canonical. A non-indexable page may point to another normalized same-site canonical path. Canonical markup remains a signal/preference; Google can choose another canonical.

## Durable publication without blob duplication in Ontology

Full page bodies are not copied into durable Ontology RUN/STATE JSON. In ACTIVE mode the publisher first stages the full bundle as an immutable content-addressed artifact. Ontology then stores only bundle references, digests, revision expectations and run-control state. The live publisher atomically swaps a manifest pointer using compare-and-swap and certifies the committed pointer by read-back.

`JsonFileProgrammaticSeoPublisher` stores immutable bundle artifacts beside the manifest, validates every artifact on load, uses temp-file write + file `fsync` + atomic rename + directory `fsync`, and serializes manifest changes with an exclusive writer lock.

A crash after staging but before run preparation can leave an unreferenced content-addressed artifact. It is not live until referenced by the manifest. Garbage collection must only remove artifacts proven unreachable from live/history references.

## Recovery and rollback

A live publish is persisted as `PREPARED` before the manifest pointer changes. Ambiguous publisher outcomes remain PREPARED. The next ACTIVE scheduler pass resumes that action before re-reading the catalog, allowing exact idempotent recovery.

Prepared actions cannot silently execute under a different policy digest. `OBSERVE_ONLY` and `KILLED` cannot thaw an ACTIVE prepared mutation.

After a certified apply, Ontology stores the exact inverse pointer action. `rollbackLastMutation()` restores the previous immutable bundle reference, or removes the bundle when the prior state was empty. Third-party drift fails compare-and-swap rather than being overwritten. This is operational rollback; CORTEX #24 owns statistical rollback.

## Modes

- `ACTIVE`: compile, stage, prepare, CAS-publish, read-back certify.
- `OBSERVE_ONLY`: compile and persist the proposed bundle digest, with no stage/publish write.
- `KILLED`: for a fresh run, performs zero catalog or publisher I/O and records only the governed kill/no-op state.

## Production activation

A production integration must supply a real controlled-content catalog, durable `OntologyTransactionPort` storage, a publisher consumed by the actual renderer/build system, an operator-controlled mode/kill switch, telemetry/error sinks, and deployment wiring that renders the exact certified bundle reference.

No CMS data, live site data, or search-engine effects are faked by this package.

## External contracts checked

- Google Search spam policies: https://developers.google.com/search/docs/essentials/spam-policies
- Google canonical guidance: https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls
- Google robots/noindex guidance: https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag
- Next.js `generateStaticParams`: https://nextjs.org/docs/app/api-reference/functions/generate-static-params
- Next.js sitemap metadata file: https://nextjs.org/docs/app/api-reference/file-conventions/metadata/sitemap
- Next.js robots metadata file: https://nextjs.org/docs/app/api-reference/file-conventions/metadata/robots
