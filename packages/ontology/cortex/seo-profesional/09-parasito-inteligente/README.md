# 09 — Parásito Inteligente

SEO Profesional #9 does not create a second programmatic SEO engine. Nexus already has the stronger canonical `packages/ontology/cortex/headless-programmatic-seo` capability with deterministic bundles, page-specific evidence, anti-doorway/near-duplicate gates, sitemap/robots adapters, durable CAS publication, recovery, rollback and a separately governed hyperlocal long-tail provider.

#9 adds the missing **property authorization boundary** around that engine. Programmatic publication is allowed only on the operator's canonical first-party origin or on a separately owned property that has explicitly delegated publication authority.

## Property authorization

- The canonical #4 website origin is first-party and does not require a second DNS proof.
- A different HTTPS property requires a TXT record at `_nexus-pseo.<hostname>`.
- The TXT value is a `nexus-pseo-v1=` token signed with HMAC-SHA256 by the Nexus operator and bound to `siteId + propertyBaseUrl + operatorWebsiteOrigin + issuedAt + expiresAt`.
- `propertyBaseUrl` is exact and path-scoped: a delegation for `https://client.example/guides/` cannot authorize `https://client.example/news/` or the whole host.
- Delegations expire and may live for at most 30 days. Verification fails closed on missing, invalid, expired or unavailable DNS evidence.
- The HMAC key is supplied by an external key provider and is never serialized into receipts, catalogs or logs.
- The configured `propertyBaseUrl` is exact. A catalog cannot silently switch domains or move publication to another base path.

The DNS challenge proves mutual authorization: the operator signs the scoped token and the property controller must publish it under that property's DNS namespace. It is not a claim that Nexus owns the delegated domain.

## Source governance

`AuthorizedProgrammaticSeoCatalogBoundary` only accepts explicitly configured catalog source IDs. Sources must be classified as either `OPERATOR_FIRST_PARTY` or `PROPERTY_OWNER_FIRST_PARTY`; there is deliberately no third-party sponsored/reputation-rental category.

After that boundary, the existing `ProgrammaticSeoEngine` remains authoritative for content quality. Its existing gates continue to require page-specific evidence and distinctive visible statements, unique metadata, navigable hierarchy, self-canonical indexable pages and bounded exact near-duplicate checks. Hyperlocal pages continue to require their existing geographic and demand evidence.

## Runtime semantics

`AuthorizedProgrammaticSeoRuntime` composes the authorization boundary with the canonical engine without modifying that engine:

1. `ACTIVE` and `OBSERVE_ONLY` require current property authorization before the canonical engine can read a catalog or publisher state.
2. A prepared canonical mutation can resume only while authorization is still valid.
3. Rollback also requires current authorization, preventing an old bundle from being republished after delegation is revoked or expires.
4. `KILLED` preserves the canonical zero-I/O kill-switch behavior and performs no authorization, catalog or publisher I/O.
5. Each result carries a receipt digest binding the canonical programmatic run digest to the property authorization proof digest.

## Search-policy boundary

This module is not a mechanism for doorway pages, expired-domain abuse, scaled-content abuse, site-reputation abuse, parasite SEO on unrelated domains or networks of near-identical properties. It does not guarantee indexing, ranking, traffic or revenue.

Google's current spam policies explicitly prohibit doorway abuse and scaled low-value content. Google also treats publishing third-party content on a trusted host primarily to exploit that host's ranking signals as site reputation abuse. #9 therefore limits publication to owned/authorized properties and leaves the canonical Nexus content-quality gates in force.

Official policy references:

- https://developers.google.com/search/docs/essentials/spam-policies
- https://developers.google.com/search/blog/2026/08/update-site-reputation-policy

## Connected master

- `#4 -> #9` by `VERIFIED_PSEO_OPERATOR_IDENTITY`: the operator identity that signs/requests property authorization must match the canonical LocalBusiness website origin.
- `#9 -> #1` by `AUTHORIZED_PROGRAMMATIC_LANDING`: an authorized indexable programmatic page remains a normal web landing and re-enters the existing acquisition/invalid-traffic circuit.

#1–#8 do not import #9 internals. #9 imports the existing headless programmatic SEO capability because reuse of that canonical engine is the purpose of this strategy.
