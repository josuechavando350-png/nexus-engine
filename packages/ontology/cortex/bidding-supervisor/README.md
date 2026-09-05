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

Reads use GAQL through `googleAds:search`. The campaign snapshot includes Google's output-only `campaign.bidding_strategy_system_status`, which Google exposes on the campaign for both standard and portfolio bidding strategies. `LEARNING_*` and `MULTIPLE_LEARNING` are treated as an explicit learning hold. Misconfigured, paused, unavailable, unknown, unspecified and other non-ready states fail closed. `ENABLED` and Google's `LIMITED_*` / `MULTIPLE_LIMITED` states may continue through the supervisor's own evidence and control guardrails.

The learning/system-status guard is evaluated before profitability work for a new run and again immediately before every non-rollback remote mutation or uncertain-write recovery. If a previously `PREPARED` write reaches that second check while Google is learning or otherwise not ready, the run stays locked and no mutate occurs. A later ACTIVE recovery must first observe a writable status again. Rollback is the deliberate safety exception: an explicitly requested rollback may bypass the learning hold, but still uses the same remote-value preflight before reversing the previously certified Cortex value.

Retry-safe reads may retry bounded 429/5xx/transport failures. **Mutations are never blindly retried.** Before every mutate, Cortex reads the live control and requires one of these states:

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
- Google bidding strategies in a learning state cannot produce a forward write. Non-ready/unknown system statuses fail closed.
- Minimum Google Ads spend and conversion evidence must be present.
- Business evidence older than `maxBusinessDataAgeMs` cannot trigger a write.
- Increase/decrease profitability thresholds have a hold band between them.
- Budget, target and portfolio-bound changes are capped by explicit relative step fractions and absolute min/max limits.
- A remote control already outside its configured absolute range is not force-clamped; that control is skipped so the supervisor cannot violate the configured relative step in one jump.
- Invalid portfolio CPC state such as floor > ceiling is fail-closed and cannot produce a bid-bound mutation.
- Only one control is selected per periodic run. When multiple controls are compatible, successive runs rotate away from the last applied control after cooldown.
- Campaign controls use campaign profitability. Portfolio controls use separately requested aggregate bidding-strategy profitability and aggregate Google strategy metrics.
- `OBSERVE_ONLY` records the proposed action but performs no mutate.
- `KILLED` performs no Google/business reads for a new run. It also refuses to resume a previously prepared forward write.

## Rollback

After a certified application, state retains the exact expected and desired absolute values. `rollbackLastMutation()` reverses that action. A rollback is a safety operation and is **not delayed by the normal forward-change cooldown**. Google Ads preflight permits rollback only if the remote control still equals the value Cortex previously applied. Third-party drift therefore fails closed instead of being overwritten.

Rollback never acts as a forward-reconciliation shortcut. If the requested rollback `runId` references a forward run, or if the campaign lock is owned by a forward `PREPARED` run, `rollbackLastMutation()` fails with `POLICY_VIOLATION` without another remote mutation attempt. Only a `PREPARED` run whose persisted reason is `ROLLBACK_APPLIED` may be resumed through the rollback path. This lets an ambiguous rollback recover after restart while an ambiguous forward write remains frozen until explicit forward reconciliation.

Rollback finalization, release of the in-flight lock, clearing of rollback eligibility and audit timestamps are one local ontology transaction. An ambiguous rollback remains `PREPARED` for the same remote-value preflight recovery semantics as a forward mutation.

## Production daemon

`production-runtime.ts` and `scripts/cortex-bidding-supervisor.mjs` connect the supervisor to an actual long-running Node process. The daemon uses the compiled ontology package, a persistent SQLite state volume, the existing Google Ads OAuth/REST adapter, and `HttpBusinessProfitabilityProvider` for an authenticated first-party profitability source.

Startup fails closed unless `NEXUS_CORTEX_STATE_DB` is an absolute non-memory path and `NEXUS_CORTEX_PERSISTENCE_ACK=durable-volume` explicitly confirms a persistent mount. It also requires an absolute `NEXUS_CORTEX_BIDDING_CONFIG`, `NEXUS_CORTEX_API_TOKEN`, Google Ads OAuth/developer-token secrets, and an HTTPS `NEXUS_PROFITABILITY_ENDPOINT` with its bearer token. No production customer or campaign identifier is compiled into the daemon; configured campaigns come from the versioned runtime config file.

The first-party profitability adapter sends the exact `BusinessProfitabilityQuery` over HTTPS with bearer authentication, rejects redirects, enforces timeout and a 32 KiB streaming response limit, accepts only JSON, and rejects unknown response fields. The supervisor independently revalidates customer, scope, reporting window, source identifier, canonical timestamp and freshness before any action can be selected.

The daemon schedules one governed cycle every configured `intervalMs` (bounded to five minutes through one day). Run IDs are deterministic for a campaign and interval bucket, so duplicate triggers in the same bucket converge on the supervisor's existing idempotency. The runtime coalesces overlapping in-process cycles and continues to the next configured campaign when one campaign fails; the overall cycle is still reported as failed when any campaign failed.

Runtime `ACTIVE / OBSERVE_ONLY / KILLED` state is persisted through `BiddingRuntimeController` under one stable NEXUS-scope control identity, independent of policy digest. Each change requires expected-revision CAS and appends an integrity-digested audit event that records the policy digest active at the transition. On policy rotation, the effective mode is always the more restrictive of the persisted operator state and the newly configured policy mode, so a stored kill cannot disappear because a policy digest changed.

The scheduler rereads `effectiveMode()` before each campaign. More importantly, the production Google Ads gateway rereads it again immediately before `applyMutation()`. A kill that arrives after planning or during Google preflight therefore blocks the forward remote write at the last local boundary. The only bypass is an internal rollback capability held while the authenticated rollback endpoint owns an exclusive safety-operation lock; that capability is never accepted from a request.

Authenticated operational endpoints provide control inspection/change, a manual cycle, and an explicit campaign rollback. Rollback may execute while the durable control remains `KILLED`, but the core rollback guard permits only a certified reversal or recovery of an already-prepared reversal. A periodic/manual cycle cannot start while the rollback safety lock is held. All operational responses are `no-store`, and runtime telemetry contains only bounded operation/status identifiers, customer/campaign IDs, reason/mode, duration and error code—not OAuth tokens, profitability records or request bodies.

The live path is:

`periodic/manual trigger -> durable runtime control -> PeriodicGoogleAdsBiddingSupervisor -> last-moment mutation guard -> Google Ads REST + authenticated first-party profitability -> OntologyTransactionPort -> durable SQLite volume`

## Audit evidence

Every run stores policy digest, mode, window, Google snapshots (including bidding-strategy system status), business snapshot, selected evidence, action, receipt/error code, status and timestamps under a SHA-256 integrity digest. Campaign state stores the current policy digest, cooldown/last-action/in-flight/rollback information under a separate digest. SQLite persistence from CORTEX #1 supplies WAL, `synchronous=FULL`, `BEGIN IMMEDIATE` and validated ontology transaction semantics.

## Scope boundary

CORTEX #2 provides this periodic Smart Bidding supervisor. Broader revenue/margin/CAC governance belongs in later control-plane capabilities and is not duplicated here. A deployment is not considered live merely because this package builds: real Google Ads credentials, accessible customer accounts, a real profitability provider, a durable state volume and the production daemon are required at runtime.
