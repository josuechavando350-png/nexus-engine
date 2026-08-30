# Local Presence audit

Status: source implementation in progress; exact-head CI required before merge.

## Capability 3/20

Implements canonical NAP, Google Business Profile drift detection, explicit approved synchronization, review retrieval/reply, and factual LocalBusiness JSON-LD.

## Revalidated external contracts

- Business Information API location reads and `locations.patch` with `updateMask`.
- Google My Business v4 review list and review reply endpoints.
- Business Profile OAuth and policy requirement that review responses made for an end-client require authorization.
- Structured data is separated from review rich-result eligibility; the package does not emit self-serving rating/review markup.

## Fail-closed invariants

- no OAuth => `UNAVAILABLE`, never fake provider success;
- malformed/provider failure => `FAIL`;
- canonical and provider snapshots are digest-bound and shape-validated;
- a caller cannot promote a fabricated object to live GBP authority;
- writes require explicit approval plus exact canonical/provider snapshot replay;
- review replies are caller-supplied approved text only; the engine never composes reputation responses;
- location writes are scoped to detected NAP drift and explicit update masks;
- LocalBusiness JSON-LD contains only canonical factual NAP and never fabricates aggregate rating/review fields;
- the operational CLI is read-only by default.

## Acceptance

Package typecheck/test/build, repository lint, and all four exact-head NEXUS workflows must pass. Final diff must contain no production placeholders/TODO/FIXME/mock adapters. Live provider success is not claimed without real credentials.
