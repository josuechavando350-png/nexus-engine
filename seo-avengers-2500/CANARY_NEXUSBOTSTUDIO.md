# SEO Avengers 2500 — Nexus Bot Studio canary

This canary is the first real-site operational integration for SEO Avengers 2500. It is deliberately restricted to `nexus-bot-studio` / `nexusbotstudio.com` and remains outside every client request path.

## What this stage proves

The canary is intended to prove the new 2500 control/evidence/sidecar path under a real public site without granting the suite a site mutation path:

```text
tenant control plane
      |
      | authorized generation only
      v
bounded NexusBotStudio public collector
      |
      | content_documents only in the initial canary
      v
atomic versioned evidence snapshot
      |
      v
read-only evidence validation
      |
      v
out-of-band M1001-M2500 sidecar
      |
      v
RELEASED / INSUFFICIENT_DATA / BLOCKED / STALE / OFF
```

The initial live canary intentionally has only public `content_documents`; it does not fabricate Search Console, Analytics, local-business, conversion, revenue or provider evidence merely to force M2500 green. Therefore the operational canary does **not** require NexusBotStudio itself to receive a `RELEASED` result. It requires the exact 1500 local modules to execute without runtime `ERROR`, and then accepts either:

- `RELEASED`, when M2500 genuinely certifies the observed evidence; or
- `BLOCKED / SUITE_NOT_RELEASE_SAFE`, when the exact execution is structurally valid but M2500 truthfully refuses release.

In the second case individual receipts remain suppressed. The proof artifact stores only redacted execution hashes, aggregate status counts, exact receipt count, terminal M2500 state and collection counters. A process/runtime failure (`SUITE_EXECUTION_FAILED`) still fails the canary.

A `RELEASED` result remains an execution/integrity statement. It is not a ranking, indexation, traffic, lead, client or revenue guarantee. A successful operational canary with `SUITE_NOT_RELEASE_SAFE` likewise does not certify NexusBotStudio SEO quality; it certifies that real evidence traversed the guarded pipeline and that the release gate refused to overclaim.

## Hard tenant boundary

The collector has no generic `siteId` or origin argument. Its site identity and network allowlist are compiled into the canary:

- site: `nexus-bot-studio`
- origin: `https://nexusbotstudio.com`
- allowed redirect/sitemap hosts: `nexusbotstudio.com`, `www.nexusbotstudio.com`

A disabled, killed, malformed or stale tenant performs no page collection. Authorization is checked before network collection, before each page fetch, immediately before evidence publication, after publication, and again inside the sidecar before execution/release.

The collector cannot be pointed at CANO or another customer through CLI arguments.

## Bounded public collection

The initial collector reads only public NexusBotStudio pages. It does not call Google, Search Console, Analytics, Ads, a CMS, Neon, Cloudflare KV or any provider API.

Collection limits:

- sitemap: at most 512 KB;
- routes: at most 24 by default and never more than 64;
- pages: at most 2 MB each;
- request timeout: 8 seconds by default, bounded to 30 seconds;
- redirects are followed manually, with every destination validated before the next request and a maximum of five redirects;
- redirect/sitemap destinations must remain on an allowed HTTPS NexusBotStudio host;
- sitemap entries with another host, query string, insecure scheme or invalid route are ignored.

Only observed visible page text is emitted as `content_documents`. Missing provider/business/search/revenue evidence is left missing; the runtime must use its existing `INSUFFICIENT_DATA` semantics rather than inventing observations.

## Atomic evidence publication

The canary uses the versioned evidence layout instead of rewriting the original flat snapshot in place:

```text
<evidence-root>/tenants/nexus-bot-studio/
  HEAD.json
  snapshots/
    <manifest-sha256-hex>/
      manifest.json
      content_documents.json
      ...
```

Dataset files and the manifest are written into a pending immutable snapshot, fsynced, and atomically renamed into `snapshots/<id>`. Only after the snapshot is durable is a pending HEAD file fsynced and atomically renamed to `HEAD.json`.

`HEAD.json` binds the snapshot to the tenant, the current control generation and the canonical manifest SHA-256. Readers reject pending publication markers, symlinks, layout drift, generation mismatch, undeclared files, dataset digest mismatch and head/manifest mismatch.

The versioned reader is integrated behind the existing `readTenantEvidenceSnapshot()` API. Existing v1 flat snapshots remain readable when no v2 `HEAD.json` / `snapshots/` structure is present. The versioned reader and writer are separate modules so the sidecar reader retains a statically testable read-only filesystem boundary.

## Hot-disable contract

The kill switch is authoritative. If it becomes active or the control generation changes while collection or execution is in flight:

- no stale collection is accepted for execution;
- any snapshot written under the old generation remains cryptographically/generation bound to that old state;
- the sidecar rechecks authorization and suppresses stale receipts;
- the website itself is unaffected because the collector/worker is not in its request path.

The live proof activates the kill switch after the first execution and requires a second attempt to return `OFF / KILL_SWITCH_ACTIVE` with no released receipts.

## Relationship to SEO Avengers 200

NexusBotStudio already has historical SEO Avengers 200 infrastructure. That stack is useful as evidence that the site has previously been observed through bounded semantic infrastructure, but it is **not** the integration path for 2500.

This canary does not call the 200 Cloudflare gateway/transformer, does not publish 2500 output to Cloudflare KV, and does not depend on the old edge HTML transformation path. The old 200 stack must not be modified merely to make this canary pass.

## CLI

The CLI deliberately exposes no tenant or origin selector:

```bash
node seo-avengers-2500/scripts/seo-avengers-2500-nexusbot-canary.mjs \
  --control-root /trusted/avengers-control \
  --evidence-root /trusted/avengers-evidence
```

An optional `--config` JSON file may provide factual project-local configuration. It must not be used to manufacture search/provider/business observations.

## Activation state

Adding this code does not permanently activate NexusBotStudio. The CI proof creates ephemeral control and evidence roots, explicitly enables only `nexus-bot-studio` for that isolated run, exercises the public collector and sidecar, proves the kill switch, and then the runner is destroyed.

CANO remains out of scope. External clients remain OFF.
