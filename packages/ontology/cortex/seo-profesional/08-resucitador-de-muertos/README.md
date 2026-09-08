# 08 — Resucitador de Muertos

Passive technology enrichment and Redis-backed reactivation intelligence for already-authorized dormant business relationships.

## Scope

This strategy does **not** exploit, vulnerability-scan, port-scan, enumerate admin paths, bypass authentication, solve CAPTCHAs, brute-force credentials, correlate CVEs, or harvest contact data. It only evaluates a bare public HTTPS homepage for candidates that already exist in a tenant's first-party CRM or owned portfolio.

The strategy deliberately separates five concerns:

1. `PassivePublicSiteProbe` resolves the public hostname, rejects non-public IP space, and pins the HTTPS connection to the address that passed authorization. It reads only the public homepage, follows at most three same-origin redirects, does not execute JavaScript or fetch subresources, and bounds the response body to 1 MiB.
2. `fingerprintPublicTechnology` recognizes a small deterministic allowlist of public stack signals from response headers, generator metadata, and asset markers. Technology vendor names are context only; no vendor or version is treated as vulnerable.
3. `PassiveTechnologyRevivalEngine` combines known dormancy with neutral public SEO/site-availability signals. It produces a hash-bound assessment and a first-party review handoff. It never sends outreach.
4. `RedisRevivalJobQueue` stores jobs in tenant-hash-tagged Redis HASH/ZSET structures and uses Lua `EVAL` for atomic enqueue, lease, completion, retry, and lease reclamation. Deduplication includes a caller-supplied scan cycle so the same cycle is idempotent while later cycles can reassess the candidate.
5. `RevivalAsyncWorker` persists the assessment through a caller-supplied sink before acknowledging the Redis lease.

## Redis transport

`RedisRespScriptClient` is a dependency-free RESP2 client built on Node's `net`/`tls` primitives. Production endpoints use `rediss://`; plaintext `redis://` is rejected except when localhost development is explicitly enabled. Commands are not automatically retried after an ambiguous network outcome.

The client is intentionally narrow: strategy #8 only needs `EVAL`. This keeps the Redis mutation surface small and makes queue atomicity auditable.

## Scoring policy

Technology detection does not add risk or opportunity score. Scoring uses only:

- configured first-party dormancy;
- public homepage network/server failure;
- HTTP error status;
- missing title;
- missing meta description;
- missing canonical;
- missing viewport;
- missing JSON-LD.

Outputs are `NO_ACTION`, `REVIEW_REACTIVATION`, or `REVIEW_OFFLINE_OR_BROKEN`. All are review classifications, not claims that a company is defunct, insecure, or exploitable.

## Master-system connection

The accumulated SEO Profesional master connects strategy #8 through structural ports:

- `#4 -> #8 VERIFIED_REVIVAL_OPERATOR_IDENTITY`: the operator/handoff origin for #8 must equal the canonical LocalBusiness origin already certified by #4.
- `#8 -> #1 QUALIFIED_REVIVAL_HANDOFF`: reviewed first-party handoffs return to the existing acquisition/traffic-gating surface; #8 does not bypass #1.

No #1–#7 strategy imports #8 internals, and #8 does not import those strategy engines.
