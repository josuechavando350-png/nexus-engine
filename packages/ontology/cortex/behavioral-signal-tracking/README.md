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

Every accepted #6 event must carry a canonical UTC timestamp, an opaque event ID, an opaque session ID, `collectionAllowed=true`, and a non-empty privacy decision reference supplied by the upstream privacy layer. CORTEX #6 does not decide legal basis or consent itself; it fails closed when upstream collection is denied. Production deployments use the CORTEX #26 boundary described below so browser requests do not supply those privacy assertions directly.

## Privacy and minimization boundary

The engine deliberately has no fields for email, phone, IP address, full user agent, advertising IDs, arbitrary traits, free-form context, or sensitive attributes. It does not infer demographics, health, religion, politics, financial status, identity, or other sensitive characteristics.

Raw event IDs, raw session IDs, and raw privacy-decision references are never written to `OntologyTransactionPort`. A secret HMAC-SHA-256 key supplied at runtime pseudonymizes session identity, event idempotency keys, and privacy decision references. The secret itself is never persisted by this module.

Durable state contains only:

- one bounded aggregate object per pseudonymous session, including counters, engagement/scroll summaries and sorted HMAC event receipts used for idempotency;
- one aggregate object per site.

There is no durable raw per-event object or reconstructable raw event stream. Session receipts are capped by policy and by a hard limit of 512 events.

## CORTEX #26 privacy isolation, retention, and key lifecycle

The production behavioral entrypoint is wrapped by CORTEX #26 rather than exposing the raw #6 identity/consent inputs to browser ingestion.

- A trusted control boundary issues short-lived session tokens only after receiving an upstream `collectionAllowed=true` decision and opaque privacy-decision reference. Browser ingest payloads cannot submit `collectionAllowed`, `privacyDecisionRef`, or a raw `sessionId`.
- Session tokens bind site, privacy-decision digest, nonce, key epoch, issuance, and expiry under HMAC. Reused client event identifiers are re-pseudonymized per server-issued session, preventing deliberate cross-session identity continuity in this telemetry layer.
- Privacy session keys come from a bounded, pre-provisioned keyring. Durable control state stores only key IDs and HMAC verifiers. Rotation is CAS-controlled; the previous key remains verification-only until every token from its epoch must have expired, then it can be retired. New session issuance fails closed when the active epoch exceeds policy age.
- A durable per-site retention index is written atomically in the same transaction as BASE or MICRO aggregates. The index tracks exact aggregate object IDs without raw browser identifiers. New sessions are refused before commit if the bounded index cannot track them.
- Retention uses fixed site windows so site totals and session aggregates cannot drift apart. At expiry, tracked BASE/MICRO session objects, both site aggregate objects, and the retention index are deleted with expected revisions. A startup sweep, periodic sweep, and synchronous pre-ingest sweep enforce the same policy.
- A state store containing legacy behavioral aggregates without a CORTEX #26 retention index is rejected. Production must use a clean private store or an explicit purge migration rather than silently adopting state whose retention start cannot be proven.
- Keyring secrets, bearer credentials, raw privacy-decision references, session tokens, and token nonces are never written to the behavioral state store or operational telemetry.

CORTEX #26 still does not determine legal basis or implement a consent registry. The trusted upstream privacy system remains authoritative for whether collection is allowed; #26 isolates that decision from browser-controlled ingest fields and binds it cryptographically to the short-lived session.

## Determinism and idempotency

Event content is digest-bound. Replaying the same event ID with identical content returns `DUPLICATE` without incrementing aggregates. Reusing the same event ID with different content fails with `CONFLICT`.

Session receipts are sorted by pseudonymous event key. Counters, engagement totals, maximum scroll depth, first/last event timestamps, and the deterministic tie-breaker for equal event timestamps are independent of delivery order. Record digests also bind the transaction `updatedAt`; therefore digest equality across different ingestion orders is only asserted when the audit clock is held constant. Session and site objects are updated atomically through `OntologyTransactionPort` with revision compare-and-swap and bounded conflict retries.

## Operational modes

- `ACTIVE`: validates and atomically persists aggregates.
- `OBSERVE_ONLY`: validates and produces the event digest without persistence.
- `KILLED`: performs no behavioral aggregate reads or writes and does not normalize raw behavioral identifiers in #6.

A request may make the current behavioral policy more restrictive, never less restrictive. CORTEX #26 retains the same durable #6 control plane; its isolation and retention wrappers do not bypass the final kill/rollback boundary.

## Guardrails

Policy controls and hard bounds cover event age, future skew, session duration, event count per session, engagement duration, surface count, element count, and write retries. Site and session state is integrity-digested and revalidated on every read. Corrupted persisted payloads fail as `INTEGRITY_FAILURE`.

CORTEX #26 additionally bounds session TTL, aggregate retention, sweep cadence, tracked sessions per site, active privacy-key age, keyring size, config size, request body size, and browser origins. Privacy control mutations require a separate control credential from ingestion.

Telemetry runs after the semantic result is known. Telemetry sink failures are isolated and cannot reverse or falsify a committed ingestion.

## Persistence and scale boundary

The implementation uses the existing `OntologyTransactionPort`. Tests exercise both the in-memory reference adapter and the durable `SqliteOntologyTransactionStore`, including close/reopen idempotency in the behavioral runtime. CORTEX #26 retention adds deletion through the same transaction boundary and refuses ephemeral state in the production executable.

The current SQLite adapter is a durable correctness adapter, not an unbounded high-throughput event bus. High-volume deployments must benchmark and provision an appropriate transaction adapter before claiming production throughput.

CORTEX #17/#37 own durable event streaming/CDP identity concerns. CORTEX #9/#29 own friction and abandonment scoring. This module records behavioral facts and aggregates only; it does not infer those scores or build a cross-channel identity graph.
