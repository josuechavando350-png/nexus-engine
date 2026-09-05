# CORTEX Behavioral Signal Tracking

CORTEX GREEN-SPEC #6 records a bounded set of behavioral signals as deterministic session and site aggregates. It is an ingestion and measurement capability, not a user-profile, fingerprinting, scoring, or consent-registry system.

## Signal contract

The public input accepts only the declared fields for these signal kinds:

- `PAGE_VIEW`
- `CTA_CLICK`
- `FORM_START`
- `FORM_SUBMIT`
- `FORM_ERROR`
- `SCROLL_DEPTH`
- `ENGAGEMENT`
- `NAVIGATION`

Surface and element IDs must come from policy allowlists. CTA/form signals require an allowlisted element ID. Engagement and scroll values are bounded and are only legal on their matching signal kind. Unknown fields are rejected rather than copied into storage.

Every accepted event must carry a canonical UTC timestamp, an opaque event ID, an opaque session ID, `collectionAllowed=true`, and a non-empty privacy decision reference supplied by the upstream privacy layer. CORTEX #6 does not decide legal basis or consent itself; it fails closed when upstream collection is denied.

## Privacy and minimization boundary

The engine deliberately has no fields for email, phone, IP address, full user agent, advertising IDs, arbitrary traits, free-form context, or sensitive attributes. It does not infer demographics, health, religion, politics, financial status, identity, or other sensitive characteristics.

Raw event IDs, raw session IDs, and raw privacy-decision references are never written to `OntologyTransactionPort`. A secret HMAC-SHA-256 key supplied at runtime pseudonymizes session identity, event idempotency keys, and privacy decision references. The secret itself is never persisted by this module.

Durable state contains only:

- one bounded aggregate object per pseudonymous session, including counters, engagement/scroll summaries and sorted HMAC event receipts used for idempotency;
- one aggregate object per site.

There is no durable raw per-event object or reconstructable raw event stream. Session receipts are capped by policy and by a hard limit of 512 events.

Key lifecycle, deletion/retention enforcement, stronger storage isolation, and consent isolation belong to CORTEX #26 and related privacy capabilities. #6 must not be treated as their substitute.

## Determinism and idempotency

Event content is digest-bound. Replaying the same event ID with identical content returns `DUPLICATE` without incrementing aggregates. Reusing the same event ID with different content fails with `CONFLICT`.

Session receipts are sorted by pseudonymous event key. Counters, engagement totals, maximum scroll depth, first/last event timestamps, and the deterministic tie-breaker for equal event timestamps are independent of delivery order. Record digests also bind the transaction `updatedAt`; therefore digest equality across different ingestion orders is only asserted when the audit clock is held constant. Session and site objects are updated atomically through `OntologyTransactionPort` with revision compare-and-swap and bounded conflict retries.

## Operational modes

- `ACTIVE`: validates and atomically persists aggregates.
- `OBSERVE_ONLY`: validates and produces the event digest without persistence.
- `KILLED`: performs no transaction-store reads or writes and does not normalize behavioral identifiers.

A request may make the current policy more restrictive, never less restrictive.

## Guardrails

Policy controls and hard bounds cover event age, future skew, session duration, event count per session, engagement duration, surface count, element count, and write retries. Site and session state is integrity-digested and revalidated on every read. Corrupted persisted payloads fail as `INTEGRITY_FAILURE`.

Telemetry runs after the semantic result is known. Telemetry sink failures are isolated and cannot reverse or falsify a committed ingestion.

## Persistence and scale boundary

The implementation uses the existing `OntologyTransactionPort`. Tests exercise both the in-memory reference adapter and the durable `SqliteOntologyTransactionStore`, including close/reopen idempotency.

The current SQLite adapter is a durable correctness adapter, not an unbounded high-throughput event bus. High-volume deployments must benchmark and provision an appropriate transaction adapter before claiming production throughput.

CORTEX #17/#37 own durable event streaming/CDP identity concerns. CORTEX #9/#29 own friction and abandonment scoring. This module records behavioral facts and aggregates only; it does not infer those scores or build a cross-channel identity graph.
