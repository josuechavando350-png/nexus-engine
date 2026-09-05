# CORTEX 02 — Periodic Bidding Supervisor via Google Ads API

This module supervises Google Smart Bidding periodically from validated first-party business profitability data. It does **not** replace Google's auction-time optimizer. It changes at most one compatible control per run, uses closed reporting windows, enforces cooldowns and bounded steps, and persists every decision through the NEXUS ontology transaction boundary.

## Runtime contract

- Use a durable `OntologyTransactionPort` in production. `SqliteOntologyTransactionStore` is the included durable file-backed implementation for a single durable volume; distributed deployments may provide another implementation of the same transaction port.
- Inject a `BusinessProfitabilityProvider` backed by validated first-party revenue/gross-profit records. The provider must return the exact requested customer/scope/window and a canonical `observedAt` timestamp.
- Inject `GoogleAdsRestClient` for live Google Ads. Credentials are runtime secrets; no developer token, OAuth client secret, refresh token, access token, customer id or login-customer id is hard-coded here.
- A scheduler supplies a unique `runId` for each periodic attempt. Reusing a terminal run id is idempotent.
- The campaign state/lock identity is independent of policy version/digest. An unresolved `PREPARED` mutation therefore continues to own the campaign across supervisor policy rotations and must be reconciled before a newer policy may plan another write.

## Google Ads transport

The adapter uses the Google Ads REST `v25` endpoint family. Google Ads minor releases in the v25 family continue to use the `v25` REST path.

Authentication uses OAuth 2.0 plus the required `developer-token` header and optional `login-customer-id`. The included refresh-token provider caches an access token only until five minutes before expiry and coalesces concurrent refreshes.

Reads use GAQL through `googleAds:search`. Retry-safe reads may retry bounded 429/5xx/transport failures. **Mutations are never blindly retried.** Before every mutate, Cortex reads the live control and requires one of these states:

1. remote == expected: the absolute mutation may be attempted;
2. remote == desired: a prior uncertain attempt is recovered as already applied;
3. anything else: fail with `REMOTE_CONFLICT`.

A mutation timeout, transport failure, 5xx, or successful HTTP response whose mutate result cannot be certified is `AMBIGUOUS_MUTATION_OUTCOME`. The supervisor keeps that run `PREPARED` and keeps the campaign lock. A later ACTIVE cycle performs the preflight again instead of planning a second change.

## Controls

The supervisor supports only explicitly compatible controls:

- campaign budget `amount_micros` through `campaignBudgets:mutate`;
- standard Maximize Conversions target CPA through `campaign.maximize_conversions.target_cpa_micros`;
- standard Maximize Conversion Value target ROAS through `campaign.maximize_conversion_value.target_roas`;
- portfolio target CPA / target ROAS through `biddingStrategies:mutate`;
- portfolio CPC ceiling/floor only on supported portfolio strategies and only when `managePortfolioBidBounds` is enabled.

Shared budgets are not changed unless `allowSharedBudgets` is explicitly enabled. Cortex never clears CPC limits in this module; it only changes an already configured limit to a bounded absolute value.

## Decision guardrails

- Observation windows contain completed UTC dates only and exclude the configured reporting lag.
- Minimum Google Ads spend and conversion evidence must be present.
- Business evidence older than `maxBusinessDataAgeMs` cannot trigger a write.
- Increase/decrease profitability thresholds have a hold band between them.
- Budget, target and portfolio-bound changes are capped by explicit relative step fractions and absolute min/max limits.
- A remote control already outside its configured absolute range is not force-clamped; that control is skipped so the supervisor cannot violate the configured relative step in one jump.
- Invalid portfolio CPC state such as floor > ceiling is fail-closed and cannot produce a bid-bound mutation.
- Only one control is selected per periodic run. When multiple controls are compatible, successive runs rotate away from the last applied control after cooldown.
- Campaign controls use campaign profitability. Portfolio controls use separately requested aggregate bidding-strategy profitability and aggregate Google strategy metrics.
- `OBSERVE_ONLY` records the proposed action but performs no mutate.
- `KILLED` performs no Google/business reads for a new run. It also refuses to resume a previously prepared remote write; the unresolved run remains frozen until ACTIVE reconciliation.

## Rollback

After a certified application, state retains the exact expected and desired absolute values. `rollbackLastMutation()` reverses that action. A rollback is a safety operation and is **not delayed by the normal forward-change cooldown**. Google Ads preflight permits rollback only if the remote control still equals the value Cortex previously applied. Third-party drift therefore fails closed instead of being overwritten.

Rollback finalization, release of the in-flight lock, clearing of rollback eligibility and audit timestamps are one local ontology transaction. An ambiguous rollback remains `PREPARED` for the same preflight recovery semantics as a forward mutation.

## Audit evidence

Every run stores policy digest, mode, window, Google snapshots, business snapshot, selected evidence, action, receipt/error code, status and timestamps under a SHA-256 integrity digest. Campaign state stores the current policy digest, cooldown/last-action/in-flight/rollback information under a separate digest. SQLite persistence from CORTEX #1 supplies WAL, `synchronous=FULL`, `BEGIN IMMEDIATE` and validated ontology transaction semantics.

## Scope boundary

CORTEX #2 provides this periodic Smart Bidding supervisor. Broader revenue/margin/CAC governance belongs in later control-plane capabilities and is not duplicated here. A deployment is not considered live merely because this package builds: real Google Ads credentials, accessible customer accounts, a real profitability provider and scheduled execution are required at runtime.
