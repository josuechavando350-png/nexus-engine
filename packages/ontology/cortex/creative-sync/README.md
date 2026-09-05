# CORTEX 03 — Near-Real-Time RSA & Ad Customizers Synchronization

This capability reconciles a versioned desired creative state with Google Ads responsive search ads (RSAs) and current ad-customizer resources. It is a governed synchronizer, not an inventory intelligence engine: inventory-derived decisions belong to CORTEX #23.

## Runtime contract

- Inject a `CreativeDesiredStateProvider` backed by a trusted control-plane source. Every snapshot carries `sourceId`, immutable `sourceVersion`, canonical UTC `observedAt`, and the complete desired subset for the customer.
- Inject `GoogleAdsCreativeRestClient` for live Google Ads access. Developer token, OAuth access/refresh credentials, login customer and customer IDs are runtime configuration; no live credentials are embedded here.
- Use a durable `OntologyTransactionPort` in production. `SqliteOntologyTransactionStore` is the included single-volume durable adapter; distributed runtimes may supply another implementation of the same transaction boundary.
- A scheduler or event relay supplies a unique `runId` for each attempt. Near-real-time convergence is achieved by repeated bounded invocations; one invocation performs at most one remote mutation.

## Google Ads surface

The REST adapter uses the repository's released Google Ads API `v25` surface and the current resources/services:

- `CustomizerAttributeService` for immutable customizer attribute name/type creation and removal;
- `CustomerCustomizerService`, `CampaignCustomizerService`, `AdGroupCustomizerService`, and `AdGroupCriterionCustomizerService` for hierarchy-specific values;
- `GoogleAdsService` GAQL reads for preflight/reconciliation;
- `AdService` for RSA updates.

Enabled customizer attribute names are case-insensitively unique and the account limit of 40 enabled attributes is enforced before creation. Attribute types are limited to `TEXT`, `NUMBER`, `PRICE`, and `PERCENT`. A customizer value must use the same type as its declared attribute.

Value replacement is represented by remove + create because the hierarchy customizer resources expose create/remove semantics. Both operations are sent in the same service mutate request with `partialFailure=false`, so Google Ads treats the request atomically. Cortex never splits one logical value replacement across two independent writes.

## RSA contract

The synchronizer requires 3–15 headlines, 2–4 descriptions, at least one final URL, and validates customer ownership for every ad resource. Static text is prevalidated against Google Ads limits:

- headline: 30 Google Ads characters;
- description: 90 Google Ads characters;
- display path: 15 Google Ads characters;
- final/final-mobile URL: absolute HTTP(S), at most 2048 characters.

Google documents double-width Korean, Japanese, and Chinese characters as counting as two; local validation accounts for common double-width Unicode ranges. Dynamic insertion syntax such as `{CUSTOMIZER.Price:10USD}` is intentionally not rejected by static-length prevalidation because the rendered replacement, not the placeholder source syntax, determines the serving text. Google Ads remains authoritative for dynamic-insertion validation.

Headline pins may only use `HEADLINE_1..3`; description pins may only use `DESCRIPTION_1..2`. RSA updates use an explicit field mask for headlines, descriptions, paths, final URLs, and final mobile URLs.

## Deterministic reconciliation

For a fresh desired snapshot, Cortex plans in dependency order:

1. create a missing declared customizer attribute;
2. converge declared customizer values;
3. converge declared RSAs;
4. return `IN_SYNC` when no difference remains.

Only the first divergence is acted on. This one-write-per-run rule prevents cross-service partial application and makes recovery deterministic. The next scheduled/event-driven invocation continues from the new remote state.

The synchronizer intentionally does not delete arbitrary remote resources that are absent from the desired subset. Destructive pruning requires an explicit ownership policy and is outside CORTEX #3.

## Guardrails and modes

- `ACTIVE`: may perform one certified remote mutation.
- `OBSERVE_ONLY`: records the exact proposed action but performs no remote write.
- `KILLED`: for a new run, performs no desired-source read and no Google read/write.
- Requested mode can only make the policy more restrictive; it cannot reactivate a killed policy.
- Source snapshots older than `maxSourceAgeMs` produce a terminal `SOURCE_STALE` no-op before Google reads.
- Immutable attribute type conflicts, the 40-attribute ceiling, missing RSAs, cross-customer resources and invalid desired-state contracts fail closed.

## Ambiguous writes and recovery

Retry-safe reads may retry bounded quota/5xx/transport failures. Mutations are never blindly retried.

Before a write, the adapter reads the remote resource and classifies it as:

- remote == expected: attempt the absolute mutation;
- remote == desired: recover the previous uncertain write as already applied;
- anything else: `REMOTE_CONFLICT`.

A timeout, transport failure, server error, or successful HTTP response whose mutate result cannot be certified is `AMBIGUOUS_MUTATION_OUTCOME`. The run remains `PREPARED`, keeps the customer lock, and a later `ACTIVE` cycle re-runs the remote preflight. `OBSERVE_ONLY`/`KILLED` cannot resume a prepared remote write.

The same mechanism covers a second failure class: if Google applies a write but Cortex cannot persist the local finalization, durable state remains `PREPARED`; the next cycle observes the desired remote state and finalizes the original run without creating a duplicate resource.

## Rollback

After every certified apply, Cortex derives and stores the exact inverse action using the Google-returned resource name. Therefore the immediately preceding mutation can be rolled back even when it created a resource whose identifier was unknown before the write.

Rollback is still preflighted remotely. RSA rollback requires the ad to equal the Cortex-applied content. Customizer value rollback requires the exact applied binding/value. Attribute rollback requires the exact attribute identity and relies on the adapter's dependency guard plus Google Ads mutation validation. Third-party drift is never overwritten.

A successful rollback clears rollback eligibility atomically with the local run/state finalization. An ambiguous rollback remains `PREPARED` and is reconciled with the same deterministic recovery rules.

## Audit evidence

Every run persists mode, reason, policy digest, source identity/version/digest/time, proposed action, Google receipt/error, status and canonical timestamps under an integrity digest. Customer state persists the active lock, last source identity, last applied action, its certified inverse rollback action and audit timestamps under a separate digest.

Production readiness still requires real credentials, a real desired-state provider, durable storage, scheduled/event-driven execution, repository CI certification and the final CORTEX audit. Building the package alone is not evidence of a live Google Ads integration.
